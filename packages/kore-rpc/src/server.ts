/**
 * Starting a kore-rpc server — the `@kframework-ts/kore-rpc/server` entry
 * point, and the only file in this package that touches `child_process`.
 *
 * Transcribed from pyk's `KoreServer` / `BoosterServer` / `kore_server`
 * (`k/pyk/src/pyk/kore/rpc.py:1218-1601`), checked against the servers' own
 * option parsers at haskell-backend `v0.1.155`
 * (`booster/library/Booster/CLOptions.hs`, `booster/tools/booster/Server.hs`).
 *
 * ```ts
 * import { KoreClient, tcpTransport } from "@kframework-ts/kore-rpc";
 * import { koreRpcServer } from "@kframework-ts/kore-rpc/server";
 *
 * const server = await koreRpcServer({ kompiledDir: "imp-kompiled", moduleName: "IMP" });
 * const client = new KoreClient(await tcpTransport(server.host, server.port, { timeout: 30_000 }));
 * try {
 *   // …
 * } finally {
 *   client.close();
 *   await server.close();
 * }
 * ```
 *
 * # It is a separate entry point on purpose
 *
 * The client half of this package is pure values plus one `node:net` socket
 * behind an interface, so it runs anywhere. Spawning a process is a different
 * capability with a different threat model and a different set of runtimes that
 * can do it, and a consumer that only speaks to a server someone else started
 * should not be linking `child_process` in to find that out. Hence the
 * `./server` subpath, and hence `index.ts` deliberately not re-exporting this
 * module.
 *
 * # Started is not ready
 *
 * {@link koreServer} and {@link boosterServer} resolve when the **process has
 * started** — Node's `spawn` event, i.e. the executable was found and the fork
 * succeeded — and *not* when the server's socket accepts connections. There is
 * no readiness signal in the protocol and none on the server's stdout worth
 * parsing, so the readiness mechanism is the connect-retry loop in
 * `tcpTransport(host, port, { timeout })`: it retries `ECONNREFUSED` every
 * 100 ms until the deadline. pyk splits the two exactly the same way
 * (`KoreServer.start` returns as soon as psutil sees a listening socket, and
 * `SingleSocketTransport` still retries), so a consumer that always pairs a
 * spawn with a `tcpTransport(..., {timeout})` behaves like pyk's does.
 *
 * # Deliberate deviations from pyk
 *
 * 1. **The ephemeral port is allocated here, not discovered.** pyk passes
 *    `--server-port 0` and then polls the *process table* through psutil until
 *    the kernel-chosen port shows up (`rpc.py:1429-1437`). That needs a
 *    process-inspection library, is Linux/macOS-specific in its details, and is
 *    unavailable to us. Instead {@link koreServer} binds a `node:net` server to
 *    port 0, reads the port the kernel handed out, closes it, and passes that
 *    number explicitly. **The TOCTOU race is real and documented**: between the
 *    close and the server's own `bind`, another process on the machine can take
 *    the port, and the server will then fail to start. It is the same race
 *    every "get a free port" helper has; pass an explicit `port` if a machine
 *    is busy enough for it to matter. `--server-port 0` is never passed on,
 *    because a server that chose its own port is a server we cannot find.
 * 2. **`close()` escalates to `SIGKILL`.** pyk sends one signal and waits
 *    forever (`rpc.py:1356-1365`). A kore-rpc server that is mid-SMT-query can
 *    ignore a `SIGTERM` for a long time, and an `await server.close()` that
 *    never returns leaks the process into whatever ran the test — an orphaned
 *    prover holding a core and a Z3 is a worse outcome than a truncated solver
 *    transcript, so after {@link KoreServerArgs.killGraceMs} (default
 *    {@link DEFAULT_KILL_GRACE_MS}) the process is killed outright.
 * 3. **`--not-log-context` is not transcribed.** pyk emits it
 *    (`rpc.py:1530`); the v0.1.155 booster CLI has no such option
 *    (`CLOptions.hs` declares `--log-context`/`-c` and nothing negative), so
 *    passing it makes the server exit with a usage error. This is upstream
 *    drift inside pyk, recorded here rather than reproduced.
 * 4. **Numeric validation happens during command assembly, and is per-binary**,
 *    so {@link buildKoreServerCommand} rejects an `smtTimeout` of `0` without a
 *    filesystem or a process being involved. pyk puts one set of checks in
 *    `_validate` alongside the path checks (`rpc.py:1367-1380`) and applies it
 *    to both servers; the two servers' option parsers do not agree, so neither
 *    do we. Four places where pyk's single rule is wrong for one of the two:
 *    `--smt-timeout` (`0` is legal on the booster, `CLOptions.hs:357-364`, and
 *    a usage error on legacy, `Options/SMT.hs:78-85`), `--smt-retry-limit`
 *    (mirror image: `0` legal on the booster, rejected by legacy's
 *    `readPositiveIntegral`), `--simplify-each` (strictly positive,
 *    `CLOptions.hs:447-454`), and `--smt-reset-interval`, which the booster
 *    does not have at all. Splitting the checks out of `_validate` is what
 *    makes all of this testable without a binary.
 * 5. **The target platform is an argument.** pyk reads `sys.platform` to pick
 *    `interpreter.so` vs `interpreter.dylib` (`rpc.py:1472-1481`);
 *    {@link BoosterExtras.platform} defaults to the host's and exists so that
 *    command assembly is a pure function on every machine.
 * 6. **A failing `--version` probe does not stop the server.** When
 *    {@link KoreServerArgs.bugReport} is set, the archive gets the server's
 *    `--version` output the way pyk's does (`rpc.py:1420`) — but pyk's
 *    `run_process_2` *raises* if the probe fails, so a `kore-rpc` that cannot
 *    answer `--version` (an old build, a wrapper script, a `PATH` oddity)
 *    takes the whole session down. Here the failure is written into
 *    `server_version.txt` as its own text and the server starts anyway: a bug
 *    report is a debugging aid, and an aid that prevents the run it was meant
 *    to record is worse than one missing a version string.
 *
 * # What is *not* a deviation
 *
 * The command array, flag for flag and in order; the `GHCRTS=-N<n>` prepend;
 * `stdin` closed and both output pipes drained; `SIGINT` rather than `SIGTERM`
 * when `--solver-transcript` is in the command, so the solver's transcript is
 * flushed; and the booster-vs-legacy divergences — the logging flags, the
 * numeric ranges of deviation (4), and `--log-format json` being booster-only —
 * every one of which is a real difference between two real binaries and not a
 * pyk quirk.
 */

import { type ChildProcess, spawn } from "node:child_process";
import type { Stats } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { z } from "zod";
import type { BugReport } from "./bugreport.js";

//////////////////////
// Arguments        //
//////////////////////

/**
 * `KoreExecLogFormat` (`rpc.py:52-55`) — the `--log-format` values, which the
 * two binaries do **not** agree on.
 *
 * `standard` and `oneline` are accepted by both. `json` is
 * **`kore-rpc-booster` only** (`readLogFormat`, `CLOptions.hs:201-206`): the
 * legacy server's reader takes exactly the two
 * (`kore/src/Kore/Log/KoreLogOptions.hs:205-208`, over a two-constructor type
 * at `:182-185`), even though its help string at `:212` still lists three.
 * {@link buildKoreServerCommand} throws a {@link RangeError} on `json` rather
 * than let the server exit with a usage error.
 *
 * The default is `oneline` on both (`CLOptions.hs:153-163`), which is also
 * pyk's.
 */
export type KoreLogFormat = "standard" | "oneline" | "json";

/**
 * `FallbackReason` (`rpc.py:1440-1443`) — which halt reasons make
 * `kore-rpc-booster`'s proxy fall back to the legacy server.
 *
 * **Capitalized**, unlike every wire-level halt reason: these are the
 * `--fallback-on` CLI values, parsed by name from the Haskell constructors
 * (`reasonReader`, `booster/tools/booster/Server.hs:492-497`, used by the
 * option at `:471-478`), and `branching` would not be recognized.
 */
export type FallbackReason = "Branching" | "Stuck" | "Aborted";

/** Every {@link FallbackReason}, in `rpc.py:1441-1443` order. */
export const FALLBACK_REASONS: readonly FallbackReason[] = ["Branching", "Stuck", "Aborted"];

/** How long {@link KoreServerHandle.close} waits before `SIGKILL` — see deviation (2). */
export const DEFAULT_KILL_GRACE_MS = 10_000;

/**
 * The default executable, when {@link KoreServerArgs.command} is omitted
 * (`rpc.py:1268-1269`). It is a bare name resolved through `PATH`; callers
 * requiring a pinned K installation should pass an absolute `command`.
 */
export const DEFAULT_KORE_COMMAND = "kore-rpc";

/** The default executable for {@link boosterServer} (`rpc.py:1496-1497`). */
export const DEFAULT_BOOSTER_COMMAND = "kore-rpc-booster";

/** What {@link KoreServerHandle.host} reports when nothing was asked for. */
const DEFAULT_HOST = "127.0.0.1";

/** One line of the server's own output, as it is produced. */
export type ServerLogSink = (line: string, stream: "stdout" | "stderr") => void;

/**
 * `KoreServerArgs` (`rpc.py:1218-1231`), plus the two things a JavaScript
 * caller needs that a Python one did not.
 */
export interface KoreServerArgs {
  /** The `*-kompiled/` directory holding `definition.kore`. */
  readonly kompiledDir: string;

  /** The module to execute in — `--module`. */
  readonly moduleName: string;

  /**
   * The port to listen on. Omitted, an ephemeral one is allocated and passed
   * explicitly — see deviation (1), including its TOCTOU caveat.
   */
  readonly port?: number;

  /**
   * The executable, and any flags that belong to it rather than to a request.
   * A string is split on whitespace, exactly as pyk splits it
   * (`rpc.py:1268-1273`). Defaults to {@link DEFAULT_KORE_COMMAND}, or to
   * {@link DEFAULT_BOOSTER_COMMAND} for {@link boosterServer}.
   */
  readonly command?: string | readonly string[];

  /**
   * `--smt-timeout`, milliseconds.
   *
   * **The accepted range depends on the binary.** Legacy `kore-rpc` reads it
   * with `readPositiveIntegral` (`kore/src/Options/SMT.hs:78-85`, reader at
   * `:150`), so it must be **positive**; the booster reads it with
   * `nonnegativeInt` and documents `0` as "no timeout"
   * (`CLOptions.hs:357-364`, the help string at `:361`), so **`0` is legal
   * there**. pyk applies the positive rule to both (`rpc.py:1378`).
   */
  readonly smtTimeout?: number;

  /**
   * `--smt-retry-limit`.
   *
   * Binary-dependent too, the other way round: legacy `kore-rpc` is
   * `readPositiveIntegral` (`Options/SMT.hs:87-94`, reader at `:151`) and
   * rejects `0`; the booster is `nonnegativeInt` (`CLOptions.hs:365-374`) and
   * accepts it. pyk applies the non-negative rule to both (`rpc.py:1379`).
   */
  readonly smtRetryLimit?: number;

  /**
   * `--smt-reset-interval`. Must be **positive** (`rpc.py:1380`).
   *
   * **Legacy `kore-rpc` only** (`Options/SMT.hs:105-112`). `kore-rpc-booster`
   * declares no such option and hard-codes `ResetInterval 100`
   * (`booster/tools/booster/Server.hs:517`), so
   * {@link buildBoosterServerCommand} throws rather than emit a flag that
   * would make the server exit with a usage error.
   */
  readonly smtResetInterval?: number;

  /** `--smt-tactic`, an SMT-LIB tactic string. Not validated, by either side. */
  readonly smtTactic?: string;

  /**
   * Where the server writes its axiom log. **Nothing else in the logging
   * group is emitted unless this is set** — that is pyk's rule
   * (`rpc.py:1406-1407`, `1536-1537`) and it is why `haskellLogFormat` and
   * `haskellLogEntries` are silently inert on their own.
   */
  readonly logAxiomsFile?: string;

  /** `--log-format`. Defaults to `"oneline"` (`rpc.py:1281`). */
  readonly haskellLogFormat?: KoreLogFormat;

  /**
   * Which log entries to enable. Spelled `--log-entries A,B` for the legacy
   * server and as a repeated `-l A -l B` for the booster — see
   * {@link buildBoosterServerCommand}.
   */
  readonly haskellLogEntries?: readonly string[];

  /**
   * The `-N` in `GHCRTS`, i.e. how many capabilities the server's runtime gets
   * (`rpc.py:1288`, `1319-1327`). Defaults to 1, must be positive.
   *
   * This is how kore-rpc parallelism is sized: the protocol is single-flight
   * per connection, so *n* concurrent requests means *n* sockets, and this is
   * the server-side half of that arrangement.
   */
  readonly haskellThreads?: number;

  /**
   * Where the server's stdout and stderr go, line by line.
   *
   * pyk logs both through two reader threads (`rpc.py:1338-1354`). Omitted,
   * both pipes are still read and the lines discarded — they must never be
   * left unread, because a full pipe buffer blocks the server mid-proof.
   */
  readonly onLog?: ServerLogSink;

  /**
   * The host to report in {@link KoreServerHandle.host}, and to bind the
   * probe socket to when allocating an ephemeral port. Defaults to
   * `127.0.0.1`.
   */
  readonly host?: string;

  /**
   * How long {@link KoreServerHandle.close} waits after its first signal
   * before sending `SIGKILL`. Defaults to {@link DEFAULT_KILL_GRACE_MS}; see
   * deviation (2). `Infinity` restores pyk's wait-forever behaviour.
   */
  readonly killGraceMs?: number;

  /**
   * A recording to seed with everything a replayer needs to stand this server
   * up again — pyk's `bug_report` (`rpc.py:1230`, populated at
   * `rpc.py:1417-1427` and, for the booster, `:1548-1552`).
   *
   * Given one, three members are archived before the process is spawned:
   * `definition.kore`, `server_version.txt` (this binary's `--version`, or the
   * reason it could not be asked — see deviation 6) and `server_instance.json`
   * (`{exe, module, extra_args}`). {@link boosterServer} adds
   * `llvm_definition/definition.kore` and `llvm_version.txt`. Those five are
   * exactly what `kore-rpc-client run-tarball` tells a reader to extract in
   * order to replay a report
   * (`haskell-backend/booster/tools/rpc-client/RpcClient.hs:626-641`).
   *
   * The **traffic** half is separate and is the caller's to wire up:
   * `recordingTransport(transport, report)` from
   * `@kframework-ts/kore-rpc/bugreport`, over the same report.
   */
  readonly bugReport?: BugReport;
}

/** What {@link BoosterServerArgs} adds — `BoosterServerArgs` (`rpc.py:1446-1453`). */
export interface BoosterExtras {
  /** The **llvm** `*-kompiled/` directory: `definition.kore`, `dt/`, and the interpreter library. */
  readonly llvmKompiledDir: string;

  /**
   * `--fallback-on`, comma-joined. Must be non-empty when given
   * (`rpc.py:1507-1508`); omitted entirely, the server keeps its own default.
   */
  readonly fallbackOn?: readonly FallbackReason[];

  /** `--interim-simplification N`. Non-negative (`rpc.py:1510-1511`). */
  readonly interimSimplification?: number;

  /**
   * `--simplify-each N`. **Strictly positive**: the option's reader is
   * `intWith (> 0)` (`CLOptions.hs:447-454`), not the `nonnegativeInt` pyk
   * checks against (`rpc.py:1513-1514`).
   */
  readonly simplifyEach?: number;

  /** `--no-post-exec-simplify`, a bare flag. */
  readonly noPostExecSimplify?: boolean;

  /** `--log-context GLOB`, repeated once per glob (`CLOptions.hs:164-173`). */
  readonly logContext?: readonly string[];

  /**
   * Which platform's interpreter library to name: `interpreter.so` on
   * `"linux"`, `interpreter.dylib` on `"darwin"`, and an error on anything
   * else — pyk's `match sys.platform` (`rpc.py:1472-1481`). Defaults to the
   * host's platform; see deviation (5).
   */
  readonly platform?: string;
}

/** Arguments for {@link boosterServer} — `KoreServerArgs` plus the booster's own. */
export interface BoosterServerArgs extends KoreServerArgs, BoosterExtras {}

/**
 * Arguments for {@link koreRpcServer}: everything both servers take, with the
 * booster's own left optional. Supplying `llvmKompiledDir` is what selects the
 * booster (`rpc.py:1591-1601`).
 */
export interface KoreRpcServerArgs extends KoreServerArgs, Partial<BoosterExtras> {}

/** {@link KoreServerArgs} with the port already decided — what command assembly needs. */
export type KoreServerCommandArgs = KoreServerArgs & { readonly port: number };

/** {@link BoosterServerArgs} with the port already decided. */
export type BoosterServerCommandArgs = BoosterServerArgs & { readonly port: number };

//////////////////////
// The handle       //
//////////////////////

/**
 * A running server. `pid`, `host` and `port` are pyk's `KoreServerInfo`
 * (`rpc.py:1234-1237`); `close` is its `close()` plus the escalation described
 * in deviation (2).
 *
 * Remember that holding one of these does **not** mean the socket is accepting
 * — see the module header.
 */
export interface KoreServerHandle {
  /** The server process's pid. */
  readonly pid: number;

  /** The host to connect to — {@link KoreServerArgs.host}, or `127.0.0.1`. */
  readonly host: string;

  /** The port the server was told to listen on. Never `0`. */
  readonly port: number;

  /**
   * Resolves when the process exits, with its exit code or the signal that
   * killed it. **Never rejects**, and never settles any other way.
   *
   * It exists because "started" is not "ready" (see the module header) and the
   * two failure modes look identical from the outside: a server still opening
   * its socket and a server that died on a usage error both refuse
   * connections, and `tcpTransport(host, port, { timeout })` will spend the
   * whole timeout retrying either one. Race them instead:
   *
   * ```ts
   * const transport = await Promise.race([
   *   tcpTransport(server.host, server.port, { timeout: 30_000 }),
   *   server.exited.then((exit) => {
   *     throw new Error(`Server exited before accepting: code ${exit.code}, signal ${exit.signal}`);
   *   }),
   * ]);
   * ```
   *
   * Note it resolves on the process's `exit`, not on its pipes reaching EOF —
   * so a server that leaves a grandchild holding stdout still settles it.
   */
  readonly exited: Promise<ServerExit>;

  /**
   * Stop the server and wait for it to exit.
   *
   * `SIGINT` when the command contains `--solver-transcript`, so the solver
   * flushes what it has recorded (`rpc.py:1358-1359`); `SIGTERM` otherwise;
   * `SIGKILL` after the grace period either way, and to the whole **process
   * group**, so a server started by a wrapper script dies with its wrapper.
   * Idempotent, and resolves immediately once the process has already exited.
   *
   * What it waits for is the process's `exit`, plus a bounded window for the
   * stdio pipes to drain. It cannot hang on a grandchild that inherited them.
   */
  close(): Promise<void>;
}

//////////////////////
// Command assembly //
//////////////////////

/** pyk's `_check_none_or_positive` (`rpc.py:1368-1370`). */
function checkPositive(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
    throw new RangeError(`Expected a positive integer for: ${name}, got: ${value}`);
  }
}

/**
 * Which of the two binaries a command is being assembled for.
 *
 * It is a parameter and not a boolean because it is read in messages: a caller
 * who passed a legacy-only flag to the booster should be told which binary
 * rejected it.
 */
type ServerKind = "kore-rpc" | "kore-rpc-booster";

/** pyk's `_check_none_or_nonnegative` (`rpc.py:1372-1374`). */
function checkNonNegative(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
    throw new RangeError(`Expected a non-negative integer for: ${name}, got: ${value}`);
  }
}

/** The executable and its own flags, as an array — pyk `rpc.py:1268-1273`. */
function resolveCommand(command: string | readonly string[] | undefined, fallback: string): readonly string[] {
  if (command === undefined) return [fallback];
  const parts = typeof command === "string" ? command.split(/\s+/u).filter((part) => part.length > 0) : [...command];
  if (parts.length === 0) return [fallback];
  return parts;
}

/**
 * `--smt-*` for the **legacy `kore-rpc`**, in `_extra_args`' order
 * (`rpc.py:1390-1400`), with that binary's own numeric rules.
 *
 * Every one of the three ranges is the legacy parser's, which is not the
 * booster's — see {@link boosterSmtArgs}:
 *
 * - `--smt-timeout` is `readPositiveIntegral`: **strictly positive**, `0` is a
 *   usage error.
 * - `--smt-retry-limit` is `readPositiveIntegral` too, so `0` is also rejected,
 *   where pyk's `_check_none_or_nonnegative` (`rpc.py:1379`) would have let it
 *   through. pyk is wrong about this binary; the parser is the authority.
 * - `--smt-reset-interval` exists **only** here.
 */
function koreSmtArgs(args: KoreServerArgs): readonly string[] {
  checkPositive(args.smtTimeout, "smtTimeout");
  checkPositive(args.smtRetryLimit, "smtRetryLimit");
  checkPositive(args.smtResetInterval, "smtResetInterval");

  const out: string[] = [];
  if (args.smtTimeout !== undefined) out.push("--smt-timeout", String(args.smtTimeout));
  if (args.smtRetryLimit !== undefined) out.push("--smt-retry-limit", String(args.smtRetryLimit));
  if (args.smtResetInterval !== undefined) out.push("--smt-reset-interval", String(args.smtResetInterval));
  if (args.smtTactic !== undefined) out.push("--smt-tactic", args.smtTactic);
  return out;
}

/**
 * `--smt-*` for the **booster**, whose parsers are the looser pair:
 *
 * - `--smt-timeout` accepts `0`, documented upstream as "0 for Nothing", i.e.
 *   no timeout at all. Rejecting it here would make an expressible server
 *   configuration unreachable.
 * - `--smt-retry-limit` is a non-negative int, pyk's rule and the booster's.
 * - `--smt-reset-interval` **does not exist**: the booster hard-codes its reset
 *   interval, so a caller who set it is asking for something that cannot
 *   happen, and silently dropping the flag would be worse than saying so.
 */
function boosterSmtArgs(args: KoreServerArgs): readonly string[] {
  if (args.smtResetInterval !== undefined) {
    throw new RangeError(
      "smtResetInterval is a legacy kore-rpc option: kore-rpc-booster has no --smt-reset-interval " +
        "(it hard-codes its reset interval), so it cannot be passed to a booster server",
    );
  }
  checkNonNegative(args.smtTimeout, "smtTimeout");
  checkNonNegative(args.smtRetryLimit, "smtRetryLimit");

  const out: string[] = [];
  if (args.smtTimeout !== undefined) out.push("--smt-timeout", String(args.smtTimeout));
  if (args.smtRetryLimit !== undefined) out.push("--smt-retry-limit", String(args.smtRetryLimit));
  if (args.smtTactic !== undefined) out.push("--smt-tactic", args.smtTactic);
  return out;
}

/**
 * `--log-format`, checked against the binary that will parse it.
 *
 * `json` is **booster-only**. The legacy server's `formatReader`
 * (`kore/src/Kore/Log/KoreLogOptions.hs:205-208`, inside `parseKoreLogFormat`
 * at `:202-213`) accepts `standard` and `oneline` and nothing else — its
 * `KoreLogFormat` type has exactly those two constructors (`:182-185`) — while
 * the help string one line below the reader (`:212`) has advertised
 * `standard, oneline, json` for years. The reader is the authority; the help
 * string is upstream drift. The booster's `readLogFormat`
 * (`CLOptions.hs:201-206`) does accept all three.
 *
 * Checked whether or not the flag will be emitted: `haskellLogFormat` is inert
 * without `logAxiomsFile`, but a value that binary could never parse is a
 * mistake worth reporting at the point it was made.
 */
function checkLogFormat(args: KoreServerArgs, kind: ServerKind): void {
  if (kind === "kore-rpc" && args.haskellLogFormat === "json") {
    throw new RangeError(
      'haskellLogFormat "json" is kore-rpc-booster only: the legacy kore-rpc server parses only ' +
        "standard|oneline (KoreLogOptions.hs:205-208), whatever its stale --help string claims",
    );
  }
}

/**
 * The **legacy kore-rpc** logging flags — `--log FILE`, `--log-format F`,
 * `--log-entries A,B` (`rpc.py:1404-1415`).
 *
 * Note `--log-entries` is emitted even when the entry list is empty, producing
 * a trailing `--log-entries ''`. That is pyk's behaviour verbatim
 * (`','.join([])` is `''`), and the server accepts it as "no entries"; it is
 * kept so a command built here is the command pyk would have built.
 */
function koreLogArgs(args: KoreServerArgs): readonly string[] {
  if (args.logAxiomsFile === undefined) return [];
  return [
    "--log",
    args.logAxiomsFile,
    "--log-format",
    args.haskellLogFormat ?? "oneline",
    "--log-entries",
    [...(args.haskellLogEntries ?? [])].join(","),
  ];
}

/**
 * The **booster** logging flags — `--log-file FILE`, `--log-format F`, and a
 * repeated `-l ENTRY` (`rpc.py:1533-1546`).
 *
 * The divergence is real: `kore-rpc-booster` has no `--log` and no
 * `--log-entries`; it declares `--log-file` (`CLOptions.hs:174-181`) and takes
 * log levels one at a time — a single `-l`/`--log-level` option
 * (`CLOptions.hs:128-140`, the `short 'l'` at `:133`) wrapped in `many`, which
 * is what makes repeating it the way to pass several. Getting this wrong means
 * the server exits with a usage error before it ever listens.
 */
function boosterLogArgs(args: KoreServerArgs): readonly string[] {
  if (args.logAxiomsFile === undefined) return [];
  const out: string[] = ["--log-file", args.logAxiomsFile, "--log-format", args.haskellLogFormat ?? "oneline"];
  for (const entry of args.haskellLogEntries ?? []) out.push("-l", entry);
  return out;
}

/** {@link KoreServerArgs.killGraceMs}, defaulted and checked. */
function grace(args: KoreServerArgs): number {
  const value = args.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  if (Number.isNaN(value) || value < 0) {
    throw new RangeError(`Expected a non-negative killGraceMs, got: ${value}`);
  }
  return value;
}

/** The port a `--server-port` may carry: a real one, never `0`. */
function checkPort(port: number): void {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new RangeError(`Expected a TCP port in 1-65535, got: ${port}`);
  }
}

/**
 * The full argv of a legacy `kore-rpc` server — pyk's `_cli_args`
 * (`rpc.py:1382-1388`) with `_extra_args` (`rpc.py:1390-1402`) inlined:
 *
 * ```text
 * <command…> <kompiledDir>/definition.kore --module <M> --server-port <P> <smt…> <log…>
 * ```
 *
 * Pure: no filesystem, no process, no clock. It does validate the numeric
 * ranges (deviation 4) and the port, throwing {@link RangeError}.
 */
export function buildKoreServerCommand(args: KoreServerCommandArgs): readonly string[] {
  checkPort(args.port);
  checkLogFormat(args, "kore-rpc");
  return [
    ...resolveCommand(args.command, DEFAULT_KORE_COMMAND),
    join(args.kompiledDir, "definition.kore"),
    "--module",
    args.moduleName,
    "--server-port",
    String(args.port),
    ...koreExtraArgs(args),
  ];
}

/**
 * pyk's `KoreServer._extra_args` (`rpc.py:1390-1402`): every flag that is
 * neither the executable, the definition, the module nor the port.
 *
 * It is a function of its own — and not merely two calls inlined into
 * {@link buildKoreServerCommand} — because it is the list that goes into a bug
 * report's `server_instance.json`, which is upstream's reason for factoring it
 * out too ("Command line arguments that are intended to be included in the bug
 * report", `rpc.py:1391`).
 */
export function koreExtraArgs(args: KoreServerArgs): readonly string[] {
  return [...koreSmtArgs(args), ...koreLogArgs(args)];
}

/** pyk's `BoosterServer._extra_args` (`rpc.py:1518-1531`) — see {@link koreExtraArgs}. */
export function boosterExtraArgs(args: BoosterServerArgs): readonly string[] {
  if (args.fallbackOn !== undefined && args.fallbackOn.length === 0) {
    throw new RangeError("Expected a non-empty 'fallbackOn', got: []");
  }
  checkNonNegative(args.interimSimplification, "interimSimplification");
  // `intWith (> 0)` (`CLOptions.hs:447-454`), not the non-negative reader pyk
  // assumes: `--simplify-each 0` is a usage error, not "never simplify".
  checkPositive(args.simplifyEach, "simplifyEach");

  const out: string[] = [
    ...boosterSmtArgs(args),
    ...boosterLogArgs(args),
    "--llvm-backend-library",
    interpreterLibrary(args),
  ];

  if (args.fallbackOn !== undefined) out.push("--fallback-on", args.fallbackOn.join(","));
  if (args.interimSimplification !== undefined)
    out.push("--interim-simplification", String(args.interimSimplification));
  if (args.simplifyEach !== undefined) out.push("--simplify-each", String(args.simplifyEach));
  if (args.noPostExecSimplify === true) out.push("--no-post-exec-simplify");
  for (const glob of args.logContext ?? []) out.push("--log-context", glob);

  return out;
}

/**
 * The full argv of a `kore-rpc-booster` server — {@link buildKoreServerCommand}
 * with the booster's logging flags instead of the legacy ones, and its own
 * options appended (`rpc.py:1518-1531`):
 *
 * ```text
 * … <smt…> <boosterLog…> --llvm-backend-library <llvm>/interpreter.so
 *   [--fallback-on A,B] [--interim-simplification N] [--simplify-each N]
 *   [--no-post-exec-simplify] [--log-context G]…
 * ```
 *
 * Pure, and throws {@link RangeError} for the booster's own numeric ranges (see
 * {@link boosterSmtArgs}) plus `interimSimplification` / `simplifyEach`, an
 * empty `fallbackOn`, a legacy-only `smtResetInterval`, and an unsupported
 * {@link BoosterExtras.platform}.
 */
export function buildBoosterServerCommand(args: BoosterServerCommandArgs): readonly string[] {
  checkPort(args.port);
  checkLogFormat(args, "kore-rpc-booster");
  return [
    ...resolveCommand(args.command, DEFAULT_BOOSTER_COMMAND),
    join(args.kompiledDir, "definition.kore"),
    "--module",
    args.moduleName,
    "--server-port",
    String(args.port),
    ...boosterExtraArgs(args),
  ];
}

/** `<llvmKompiledDir>/interpreter.{so,dylib}` — pyk `rpc.py:1472-1481`. */
export function interpreterLibrary(args: BoosterExtras): string {
  const platform = args.platform ?? process.platform;
  const extension = platform === "linux" ? "so" : platform === "darwin" ? "dylib" : undefined;
  if (extension === undefined) throw new RangeError(`Unsupported platform: ${platform}`);
  return join(args.llvmKompiledDir, `interpreter.${extension}`);
}

//////////////////////
// Validation       //
//////////////////////

/** `stat`, with "there is nothing here" as a value rather than an exception. */
async function statOrNothing(path: string): Promise<Stats | undefined> {
  try {
    return await stat(path);
  } catch {
    return undefined;
  }
}

async function checkDir(path: string, what: string): Promise<void> {
  const info = await statOrNothing(path);
  if (info === undefined) throw new Error(`${what} does not exist: ${path}`);
  if (!info.isDirectory()) throw new Error(`${what} is not a directory: ${path}`);
}

async function checkFile(path: string, what: string): Promise<void> {
  const info = await statOrNothing(path);
  if (info === undefined) throw new Error(`${what} does not exist: ${path}`);
  if (!info.isFile()) throw new Error(`${what} is not a file: ${path}`);
}

/**
 * pyk's `KoreServer._validate` (`rpc.py:1367-1380`), path checks only — the
 * numeric ones happen during command assembly.
 *
 * Worth doing before spawning rather than letting the server complain: a
 * missing `definition.kore` otherwise surfaces as a process that exits with a
 * message on a pipe nobody is reading yet.
 */
async function validateKoreDirs(args: KoreServerArgs): Promise<void> {
  await checkDir(args.kompiledDir, "kompiled directory");
  await checkFile(join(args.kompiledDir, "definition.kore"), "definition.kore");
}

/** pyk's `BoosterServer._validate` (`rpc.py:1501-1516`), path checks only. */
async function validateBoosterDirs(args: BoosterServerArgs): Promise<void> {
  await checkDir(args.llvmKompiledDir, "llvm kompiled directory");
  await checkFile(interpreterLibrary(args), "llvm interpreter library");
  await checkFile(join(args.llvmKompiledDir, "definition.kore"), "llvm definition.kore");
  await checkDir(join(args.llvmKompiledDir, "dt"), "llvm decision-tree directory");
  await validateKoreDirs(args);
}

//////////////////////
// Ports            //
//////////////////////

/**
 * An ephemeral port, obtained by binding one and letting go — see deviation
 * (1) for the race this accepts and why psutil's approach was not an option.
 */
async function allocatePort(host: string): Promise<number> {
  const probe = createServer();
  try {
    const port = await new Promise<number>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen({ host, port: 0 }, () => {
        const address = probe.address();
        if (address === null || typeof address === "string") {
          reject(new Error(`Could not read an ephemeral port from ${host}`));
          return;
        }
        resolve(address.port);
      });
    });
    return port;
  } finally {
    await new Promise<void>((resolve) => {
      probe.close(() => {
        resolve();
      });
    });
  }
}

//////////////////////
// Spawning         //
//////////////////////

/** `GHCRTS=-N<n>` **prepended** to whatever the environment already had (`rpc.py:1319-1327`). */
function serverEnv(haskellThreads: number | undefined): NodeJS.ProcessEnv {
  checkPositive(haskellThreads, "haskellThreads");
  const inherited = process.env["GHCRTS"];
  const ghcrts = [`-N${haskellThreads ?? 1}`, inherited]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join(" ");
  return { ...process.env, GHCRTS: ghcrts };
}

/**
 * Read a pipe line by line into `sink`, and read it whether or not anyone is
 * listening: an unread pipe fills, and a server blocked on a 64 KB buffer is a
 * server that has stopped proving.
 */
function drain(stream: NodeJS.ReadableStream | null, name: "stdout" | "stderr", sink: ServerLogSink | undefined): void {
  if (stream === null) return;
  stream.setEncoding("utf8");
  let rest = "";
  stream.on("data", (chunk: string) => {
    if (sink === undefined) return;
    rest += chunk;
    let newline = rest.indexOf("\n");
    while (newline >= 0) {
      const line = rest.slice(0, newline);
      rest = rest.slice(newline + 1);
      sink(line.endsWith("\r") ? line.slice(0, -1) : line, name);
      newline = rest.indexOf("\n");
    }
  });
  stream.on("end", () => {
    if (sink !== undefined && rest.length > 0) sink(rest, name);
    rest = "";
  });
  // A pipe that errors after the process died is not interesting, but an
  // unhandled `error` event on a stream is fatal to the process reading it.
  stream.on("error", () => {
    rest = "";
  });
}

/**
 * How the server process ended — {@link KoreServerHandle.exited}'s value.
 *
 * Exactly one of the two is non-null, as in Node's `exit` event: a code for a
 * process that returned, a signal name for one that was killed.
 */
export interface ServerExit {
  readonly code: number | null;
  readonly signal: string | null;
}

/** Structural process-exit observation; exit ordering remains process-handle semantics. */
export const ServerExitSchema: z.ZodType<ServerExit> = z.object({
  code: z.number().nullable(),
  signal: z.string().nullable(),
});

/**
 * How long, after the child has *exited*, to keep waiting for its pipes to
 * reach EOF so the last log lines are delivered — see {@link exitOf}.
 */
const CLOSE_FLUSH_MS = 200;

/**
 * Resolves when the child has **exited**, whatever the reason. Never rejects.
 *
 * `exit`, deliberately, and not `close`. Node fires `close` only once every
 * stdio pipe has reached EOF, and a pipe stays open as long as *any* process
 * holds the write end — including a grandchild the server forked and left
 * running, which is exactly the shape of a `kore-rpc` installed as a wrapper
 * script. Waiting on `close` there means `await server.close()` never returns,
 * even after the process it was waiting for has been `SIGKILL`ed.
 */
function exitOf(child: ChildProcess): Promise<ServerExit> {
  return new Promise<ServerExit>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      resolve({ code, signal });
    });
  });
}

/**
 * Give the pipes a bounded window to drain after the process has exited.
 *
 * In the normal case `close` follows `exit` within a tick and the last few log
 * lines reach {@link KoreServerArgs.onLog} before `close()` resolves. In the
 * grandchild case it never arrives, so the window is capped: losing the tail of
 * a log is a far smaller cost than an `await` that never returns.
 */
function flushOf(child: ChildProcess): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, CLOSE_FLUSH_MS);
    timer.unref?.();
    child.once("close", finish);
  });
}

/**
 * Spawn, and resolve once the process really started — or reject if it could
 * not.
 *
 * `detached: true` puts the child in a **process group of its own**, which is
 * what makes the `SIGKILL` escalation in {@link handleFor} able to reach a
 * grandchild: a wrapper script that forked the real server and exited leaves
 * that server running, and killing the wrapper's pid alone would orphan it.
 * The polite signals still go to the child itself, as pyk's do.
 */
function spawnServer(command: readonly string[], env: NodeJS.ProcessEnv): Promise<ChildProcess> {
  const [executable, ...rest] = command;
  if (executable === undefined) throw new RangeError("Empty server command");

  return new Promise<ChildProcess>((resolve, reject) => {
    const child = spawn(executable, rest, { env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    child.once("error", (error: Error) => {
      reject(new Error(`Could not start ${executable}: ${error.message}`, { cause: error }));
    });
    child.once("spawn", () => {
      resolve(child);
    });
  });
}

/**
 * `SIGKILL` the child's whole process group, falling back to the child alone.
 *
 * The negated pid is POSIX for "the group"; it throws `ESRCH` if the group is
 * already gone and `EPERM` on a platform that will not do this, and neither is
 * worth failing a shutdown over — hence the fallback to the plain
 * `child.kill`, which is what this did before.
 */
function killGroup(child: ChildProcess): void {
  const { pid } = child;
  if (pid !== undefined) {
    try {
      process.kill(-pid, "SIGKILL");
      return;
    } catch {
      // Fall through: no group, no permission, or not a POSIX platform.
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // The process is already gone, which is the outcome we wanted anyway.
  }
}

/** The handle, including the two-stage shutdown of deviation (2). */
function handleFor(
  child: ChildProcess,
  command: readonly string[],
  host: string,
  port: number,
  killGraceMs: number,
): KoreServerHandle {
  const exited = exitOf(child);
  // pyk checks the *command* array, not the assembled argv (`rpc.py:1358`), so
  // a `--solver-transcript` reaches this only by being part of `command`.
  const usesTranscript = command.includes("--solver-transcript");
  let closing: Promise<void> | undefined;

  const pid = child.pid;
  if (pid === undefined) throw new Error("The server process reported no pid");

  return {
    pid,
    host,
    port,
    exited,
    close(): Promise<void> {
      closing ??= (async () => {
        if (child.exitCode === null && child.signalCode === null) {
          // The polite signal goes to the child itself, as pyk's does
          // (`rpc.py:1358-1359`); only the escalation widens to the group.
          child.kill(usesTranscript ? "SIGINT" : "SIGTERM");
        }
        if (Number.isFinite(killGraceMs)) {
          const timer = setTimeout(() => {
            killGroup(child);
          }, killGraceMs);
          // `unref` so a pending grace timer cannot, by itself, hold the event
          // loop open past the point where everything else is done.
          timer.unref?.();
          try {
            await exited;
          } finally {
            clearTimeout(timer);
          }
        } else {
          await exited;
        }
        // The process is gone; give its pipes a bounded moment to deliver
        // whatever they still hold. See `flushOf`.
        await flushOf(child);
      })();
      return closing;
    },
  };
}

//////////////////////
// Bug reports      //
//////////////////////

/**
 * The command asked for `llvm_version.txt` — pyk `rpc.py:1551`.
 *
 * Note it takes **no** `--version`: `llvm-backend-version` is a program whose
 * whole job is to print one, unlike the two servers.
 */
const LLVM_VERSION_COMMAND: readonly string[] = ["llvm-backend-version"];

/**
 * Run a short command and capture its stdout, trimmed — pyk's `run_process_2`
 * (`rpc.py:1420`, `:1551`).
 *
 * **Never rejects** — see deviation (6). A binary that is missing, that exits
 * non-zero or that writes nothing yields a line saying so, which goes into the
 * archive in place of the version and is strictly more useful than an exception
 * thrown at the caller who only asked for a server.
 */
function captureStdout(command: readonly string[]): Promise<string> {
  const [executable, ...rest] = command;
  const shown = command.join(" ");
  if (executable === undefined) return Promise.resolve("<empty command>");

  return new Promise<string>((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(executable, rest, { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error: Error) => {
      resolve(`<could not run ${shown}: ${error.message}>`);
    });
    child.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
      const text = stdout.trim();
      if (code === 0) {
        resolve(text);
        return;
      }
      const how = signal === null ? `exit ${String(code)}` : `signal ${signal}`;
      resolve(`<${shown} failed (${how})>\n${text}\n${stderr.trim()}`.trimEnd());
    });
  });
}

/**
 * pyk's `KoreServer._populate_bug_report` (`rpc.py:1417-1427`).
 *
 * `extra_args` is `self._command[1:] + self._extra_args()` verbatim: the flags
 * that belong to the *invocation*, without the definition, the module or the
 * port — a replayer supplies those three itself from `definition.kore` and
 * this file's `module`.
 */
async function populateKoreBugReport(report: BugReport, args: KoreServerArgs): Promise<void> {
  const command = resolveCommand(args.command, DEFAULT_KORE_COMMAND);
  const executable = command[0] ?? DEFAULT_KORE_COMMAND;
  report.addFile(join(args.kompiledDir, "definition.kore"), "definition.kore");
  report.addFileContents(await captureStdout([executable, "--version"]), "server_version.txt");
  report.addFileContents(
    JSON.stringify({
      exe: executable,
      module: args.moduleName,
      extra_args: [...command.slice(1), ...koreExtraArgs(args)],
    }),
    "server_instance.json",
  );
}

/** pyk's `BoosterServer._populate_bug_report` (`rpc.py:1548-1552`). */
async function populateBoosterBugReport(report: BugReport, args: BoosterServerArgs): Promise<void> {
  const command = resolveCommand(args.command, DEFAULT_BOOSTER_COMMAND);
  const executable = command[0] ?? DEFAULT_BOOSTER_COMMAND;
  report.addFile(join(args.kompiledDir, "definition.kore"), "definition.kore");
  report.addFileContents(await captureStdout([executable, "--version"]), "server_version.txt");
  report.addFileContents(
    JSON.stringify({
      exe: executable,
      module: args.moduleName,
      extra_args: [...command.slice(1), ...boosterExtraArgs(args)],
    }),
    "server_instance.json",
  );
  // The llvm definition, not the interpreter library: a replayer re-runs
  // `llvm-kompile` on it, because a shared object built here would not load
  // there (`RpcClient.hs:636-641`).
  report.addFile(join(args.llvmKompiledDir, "definition.kore"), "llvm_definition/definition.kore");
  report.addFileContents(await captureStdout(LLVM_VERSION_COMMAND), "llvm_version.txt");
}

//////////////////////
// The spawners     //
//////////////////////

/**
 * Start a **legacy `kore-rpc`** server — pyk's `KoreServer` (`rpc.py:1240-1437`).
 *
 * Validates the paths, chooses a port (an ephemeral one unless
 * {@link KoreServerArgs.port} says otherwise), assembles the command with
 * {@link buildKoreServerCommand}, and spawns it with `stdin` closed and both
 * output pipes drained into {@link KoreServerArgs.onLog}.
 *
 * Resolving means the process started, **not** that the socket accepts — see
 * the module header, and connect with `tcpTransport(host, port, { timeout })`.
 *
 * @throws {RangeError} for an out-of-range {@link KoreServerArgs.killGraceMs},
 *   before any I/O; and for any other out-of-range numeric argument during
 *   command assembly, which happens after the path checks but still before the
 *   process is spawned. Nothing this function throws can leave a child behind.
 * @throws {Error} when a required path is missing, or the executable is not.
 */
export async function koreServer(args: KoreServerArgs): Promise<KoreServerHandle> {
  // Validate before spawning so every live server has a handle.
  const killGraceMs = grace(args);
  await validateKoreDirs(args);
  const host = args.host ?? DEFAULT_HOST;
  const port = args.port ?? (await allocatePort(host));
  const command = buildKoreServerCommand({ ...args, port });
  // Before the spawn, as pyk does (`rpc.py:1314-1315`): a server that dies on
  // startup is exactly the case a bug report has to survive.
  if (args.bugReport !== undefined) await populateKoreBugReport(args.bugReport, args);
  const child = await spawnServer(command, serverEnv(args.haskellThreads));
  drain(child.stdout, "stdout", args.onLog);
  drain(child.stderr, "stderr", args.onLog);
  return handleFor(child, resolveCommand(args.command, DEFAULT_KORE_COMMAND), host, port, killGraceMs);
}

/**
 * Start a **`kore-rpc-booster`** server — pyk's `BoosterServer`
 * (`rpc.py:1456-1552`).
 *
 * Everything {@link koreServer} does, plus the llvm-side validation
 * (`definition.kore`, `dt/`, and the interpreter library) and the booster's own
 * flags — including the ones legacy `kore-rpc` accepts and this binary does
 * not; see deviation (4).
 */
export async function boosterServer(args: BoosterServerArgs): Promise<KoreServerHandle> {
  const killGraceMs = grace(args);
  await validateBoosterDirs(args);
  const host = args.host ?? DEFAULT_HOST;
  const port = args.port ?? (await allocatePort(host));
  const command = buildBoosterServerCommand({ ...args, port });
  if (args.bugReport !== undefined) await populateBoosterBugReport(args.bugReport, args);
  const child = await spawnServer(command, serverEnv(args.haskellThreads));
  drain(child.stdout, "stdout", args.onLog);
  drain(child.stderr, "stderr", args.onLog);
  return handleFor(child, resolveCommand(args.command, DEFAULT_BOOSTER_COMMAND), host, port, killGraceMs);
}

/**
 * Start whichever server the arguments describe — pyk's `kore_server`
 * (`rpc.py:1555-1601`).
 *
 * The selection rule is pyk's, exactly: **the booster iff `llvmKompiledDir` is
 * given** (`rpc.py:1591-1601`, where the check is on `llvm_definition_dir`).
 * Nothing sniffs the filesystem and nothing inspects the command; a caller who
 * wants the legacy server with an llvm directory lying around simply does not
 * pass it.
 */
export function koreRpcServer(args: KoreRpcServerArgs): Promise<KoreServerHandle> {
  const { llvmKompiledDir } = args;
  if (llvmKompiledDir === undefined) return koreServer(args);
  return boosterServer({ ...args, llvmKompiledDir });
}
