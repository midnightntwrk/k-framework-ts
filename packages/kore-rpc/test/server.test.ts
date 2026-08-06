/**
 * The server spawner — `src/server.ts`.
 *
 * Two halves, and the split is the point of the module's design. The first is
 * **command assembly**, which is a pure function of its arguments and is where
 * every flag pyk emits is pinned, flag for flag and in order
 * (`k/pyk/src/pyk/kore/rpc.py:1382-1415` for the legacy server,
 * `:1518-1546` for the booster). The second actually starts a process — a
 * three-line fake server written into a temporary directory, not a real
 * `kore-rpc` — which is the only way to exercise the port allocation, the
 * output draining and the two-stage shutdown at all.
 *
 * Nothing here needs a K installation, a network, or the `fixtures/` corpus.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, describe, expect, test } from "bun:test";
import {
  type BoosterServerCommandArgs,
  type KoreServerCommandArgs,
  boosterServer,
  buildBoosterServerCommand,
  buildKoreServerCommand,
  interpreterLibrary,
  koreRpcServer,
  koreServer,
} from "../src/server.ts";
import { rejection } from "./helpers/assert.ts";

//////////////////////////
// Command assembly     //
//////////////////////////

const BASE: KoreServerCommandArgs = { kompiledDir: "imp-kompiled", moduleName: "IMP", port: 41011 };

const BOOSTER_BASE: BoosterServerCommandArgs = {
  ...BASE,
  llvmKompiledDir: "imp-llvm-kompiled",
  platform: "linux",
};

describe("buildKoreServerCommand", () => {
  test("the minimal command is pyk's `_cli_args` (`rpc.py:1382-1388`)", () => {
    expect(buildKoreServerCommand(BASE)).toEqual([
      "kore-rpc",
      join("imp-kompiled", "definition.kore"),
      "--module",
      "IMP",
      "--server-port",
      "41011",
    ]);
  });

  test("a string command is split on whitespace (`rpc.py:1270-1271`)", () => {
    const command = buildKoreServerCommand({ ...BASE, command: "  kore-rpc-dev  --solver-transcript t.smt2 " });
    expect(command.slice(0, 3)).toEqual(["kore-rpc-dev", "--solver-transcript", "t.smt2"]);
    expect(command[3]).toBe(join("imp-kompiled", "definition.kore"));
  });

  test("an array command is taken as given", () => {
    expect(buildKoreServerCommand({ ...BASE, command: ["booster-dev"] })[0]).toBe("booster-dev");
  });

  test("the SMT flags come after the server flags, in declaration order (`rpc.py:1390-1400`)", () => {
    expect(
      buildKoreServerCommand({
        ...BASE,
        smtTimeout: 300,
        smtRetryLimit: 2,
        smtResetInterval: 100,
        smtTactic: "(check-sat-using smt)",
      }).slice(6),
    ).toEqual([
      "--smt-timeout",
      "300",
      "--smt-retry-limit",
      "2",
      "--smt-reset-interval",
      "100",
      "--smt-tactic",
      "(check-sat-using smt)",
    ]);
  });

  test("the legacy logging flags: `--log`, `--log-format`, comma-joined `--log-entries`", () => {
    expect(
      buildKoreServerCommand({
        ...BASE,
        logAxiomsFile: "kore.log",
        haskellLogFormat: "standard",
        haskellLogEntries: ["DebugAttemptEquation", "DebugApplyEquation"],
      }).slice(6),
    ).toEqual([
      "--log",
      "kore.log",
      "--log-format",
      "standard",
      "--log-entries",
      "DebugAttemptEquation,DebugApplyEquation",
    ]);
  });

  test("no log file means no logging flags at all, whatever else was asked for", () => {
    expect(buildKoreServerCommand({ ...BASE, haskellLogFormat: "standard", haskellLogEntries: ["A"] })).toEqual(
      buildKoreServerCommand(BASE),
    );
  });

  test("`--log-format json` is booster-only, and the legacy builder says so (`KoreLogOptions.hs:205-208`)", () => {
    expect(() => buildKoreServerCommand({ ...BASE, haskellLogFormat: "json", logAxiomsFile: "kore.log" })).toThrow(
      RangeError,
    );
    expect(() => buildKoreServerCommand({ ...BASE, haskellLogFormat: "json" })).toThrow(
      /kore-rpc-booster only.*standard\|oneline/su,
    );
    // The other two are fine on both binaries.
    for (const format of ["standard", "oneline"] as const) {
      expect(buildKoreServerCommand({ ...BASE, haskellLogFormat: format, logAxiomsFile: "kore.log" })).toContain(
        format,
      );
    }
  });

  test("the log format defaults to oneline (`rpc.py:1281`)", () => {
    expect(buildKoreServerCommand({ ...BASE, logAxiomsFile: "kore.log" }).slice(6)).toEqual([
      "--log",
      "kore.log",
      "--log-format",
      "oneline",
      "--log-entries",
      "",
    ]);
  });

  test("the SMT ranges are the legacy parser's, and `--server-port 0` is never buildable", () => {
    expect(() => buildKoreServerCommand({ ...BASE, smtTimeout: 0 })).toThrow(/positive integer for: smtTimeout/u);
    expect(() => buildKoreServerCommand({ ...BASE, smtRetryLimit: -1 })).toThrow(
      /positive integer for: smtRetryLimit/u,
    );
    expect(() => buildKoreServerCommand({ ...BASE, smtResetInterval: 0 })).toThrow(
      /positive integer for: smtResetInterval/u,
    );
    expect(() => buildKoreServerCommand({ ...BASE, port: 0 })).toThrow(/TCP port in 1-65535/u);
    expect(() => buildKoreServerCommand({ ...BASE, port: 70000 })).toThrow(/TCP port in 1-65535/u);
  });

  test("legacy `--smt-retry-limit 0` is a usage error (`Options/SMT.hs:151`, readPositiveIntegral)", () => {
    // pyk's `_check_none_or_nonnegative` (`rpc.py:1379`) would have allowed it;
    // the binary's own reader does not.
    expect(() => buildKoreServerCommand({ ...BASE, smtRetryLimit: 0 })).toThrow(/positive integer for: smtRetryLimit/u);
  });

  test("legacy `--smt-timeout 0` is a usage error (`Options/SMT.hs:150`)", () => {
    expect(() => buildKoreServerCommand({ ...BASE, smtTimeout: 0 })).toThrow(RangeError);
  });
});

describe("buildBoosterServerCommand", () => {
  test("the default executable is kore-rpc-booster, and the library is always passed", () => {
    expect(buildBoosterServerCommand(BOOSTER_BASE)).toEqual([
      "kore-rpc-booster",
      join("imp-kompiled", "definition.kore"),
      "--module",
      "IMP",
      "--server-port",
      "41011",
      "--llvm-backend-library",
      join("imp-llvm-kompiled", "interpreter.so"),
    ]);
  });

  test("the interpreter extension is per platform, and nothing else is supported", () => {
    expect(interpreterLibrary({ llvmKompiledDir: "llvm", platform: "linux" })).toBe(join("llvm", "interpreter.so"));
    expect(interpreterLibrary({ llvmKompiledDir: "llvm", platform: "darwin" })).toBe(join("llvm", "interpreter.dylib"));
    expect(() => interpreterLibrary({ llvmKompiledDir: "llvm", platform: "win32" })).toThrow(
      /Unsupported platform: win32/u,
    );
  });

  test("every booster option, in `_extra_args` order (`rpc.py:1518-1531`)", () => {
    expect(
      buildBoosterServerCommand({
        ...BOOSTER_BASE,
        fallbackOn: ["Branching", "Stuck", "Aborted"],
        interimSimplification: 0,
        simplifyEach: 2,
        noPostExecSimplify: true,
        logContext: ["*rewrite*", "*abort*"],
      }).slice(6),
    ).toEqual([
      "--llvm-backend-library",
      join("imp-llvm-kompiled", "interpreter.so"),
      "--fallback-on",
      "Branching,Stuck,Aborted",
      "--interim-simplification",
      "0",
      "--simplify-each",
      "2",
      "--no-post-exec-simplify",
      "--log-context",
      "*rewrite*",
      "--log-context",
      "*abort*",
    ]);
  });

  test("`--not-log-context` is never emitted — it does not exist in the v0.1.155 CLI", () => {
    const command = buildBoosterServerCommand({ ...BOOSTER_BASE, logContext: ["*rewrite*"] });
    expect(command).not.toContain("--not-log-context");
  });

  test("`noPostExecSimplify: false` is not a flag", () => {
    expect(buildBoosterServerCommand({ ...BOOSTER_BASE, noPostExecSimplify: false })).not.toContain(
      "--no-post-exec-simplify",
    );
  });

  test("the booster logging flags diverge: `--log-file` and a repeated `-l`", () => {
    expect(
      buildBoosterServerCommand({
        ...BOOSTER_BASE,
        logAxiomsFile: "kore.log",
        haskellLogEntries: ["Rewrite", "Simplify"],
      }).slice(6, 12),
    ).toEqual(["--log-file", "kore.log", "--log-format", "oneline", "-l", "Rewrite"]);
  });

  test("the same arguments produce different logging flags on the two servers", () => {
    const args = { ...BOOSTER_BASE, logAxiomsFile: "kore.log", haskellLogEntries: ["Rewrite"] };
    expect(buildKoreServerCommand(args)).toContain("--log");
    expect(buildKoreServerCommand(args)).toContain("--log-entries");
    expect(buildBoosterServerCommand(args)).toContain("--log-file");
    expect(buildBoosterServerCommand(args)).not.toContain("--log-entries");
  });

  test("the booster's own ranges (`rpc.py:1507-1514`)", () => {
    expect(() => buildBoosterServerCommand({ ...BOOSTER_BASE, fallbackOn: [] })).toThrow(/non-empty 'fallbackOn'/u);
    expect(() => buildBoosterServerCommand({ ...BOOSTER_BASE, interimSimplification: -1 })).toThrow(
      /non-negative integer for: interimSimplification/u,
    );
    expect(() => buildBoosterServerCommand({ ...BOOSTER_BASE, simplifyEach: -1 })).toThrow(
      /positive integer for: simplifyEach/u,
    );
  });

  test("`--simplify-each 0` is rejected: the reader is `intWith (> 0)` (`CLOptions.hs:447-454`)", () => {
    expect(() => buildBoosterServerCommand({ ...BOOSTER_BASE, simplifyEach: 0 })).toThrow(
      /positive integer for: simplifyEach/u,
    );
    expect(buildBoosterServerCommand({ ...BOOSTER_BASE, simplifyEach: 1 })).toContain("--simplify-each");
    // `--interim-simplification` really is the non-negative one of the pair.
    expect(buildBoosterServerCommand({ ...BOOSTER_BASE, interimSimplification: 0 })).toContain(
      "--interim-simplification",
    );
  });

  test('booster `--smt-timeout 0` is legal — "0 for Nothing" (`CLOptions.hs:357-364`)', () => {
    expect(buildBoosterServerCommand({ ...BOOSTER_BASE, smtTimeout: 0 }).slice(6, 8)).toEqual(["--smt-timeout", "0"]);
    expect(() => buildBoosterServerCommand({ ...BOOSTER_BASE, smtTimeout: -1 })).toThrow(
      /non-negative integer for: smtTimeout/u,
    );
  });

  test("booster `--smt-retry-limit 0` is legal (`nonnegativeInt`, `CLOptions.hs:365-374`)", () => {
    expect(buildBoosterServerCommand({ ...BOOSTER_BASE, smtRetryLimit: 0 }).slice(6, 8)).toEqual([
      "--smt-retry-limit",
      "0",
    ]);
  });

  test("`smtResetInterval` is legacy-only: the booster has no such flag (`Server.hs:517`)", () => {
    expect(() => buildBoosterServerCommand({ ...BOOSTER_BASE, smtResetInterval: 100 })).toThrow(RangeError);
    expect(() => buildBoosterServerCommand({ ...BOOSTER_BASE, smtResetInterval: 100 })).toThrow(
      /smtResetInterval is a legacy kore-rpc option/u,
    );
    expect(buildKoreServerCommand({ ...BOOSTER_BASE, smtResetInterval: 100 })).toContain("--smt-reset-interval");
  });

  test("`--log-format json` is accepted by the booster (`CLOptions.hs:201-206`)", () => {
    expect(
      buildBoosterServerCommand({ ...BOOSTER_BASE, logAxiomsFile: "kore.log", haskellLogFormat: "json" }).slice(6, 10),
    ).toEqual(["--log-file", "kore.log", "--log-format", "json"]);
  });
});

//////////////////////////
// Spawning, for real   //
//////////////////////////

/**
 * A temporary `*-kompiled/`-shaped directory holding a `definition.kore` the
 * validator will accept and a JavaScript "server" that only has to outlive the
 * assertions.
 */
const WORKSPACE = mkdtempSync(join(tmpdir(), "kore-rpc-server-"));
const FAKE_SERVER = join(WORKSPACE, "fake-server.js");

writeFileSync(join(WORKSPACE, "definition.kore"), "[]\nmodule TEST endmodule []\n");
writeFileSync(
  FAKE_SERVER,
  [
    // Announce on both pipes so the drainer is exercised on each, then stay up
    // until a signal arrives.
    "process.stdout.write('listening ' + process.argv.slice(2).join(' ') + '\\n');",
    "process.stderr.write('warming up\\n');",
    "setInterval(function () {}, 1000);",
    "",
  ].join("\n"),
);

const FAKE_COMMAND: readonly string[] = [process.execPath, FAKE_SERVER];

afterAll(() => {
  rmSync(WORKSPACE, { recursive: true, force: true });
});

describe("koreServer", () => {
  test("starts a process, allocates a port, drains both pipes, and stops", async () => {
    const lines: (readonly [string, string])[] = [];
    let firstLine!: (value: void) => void;
    const sawOutput = new Promise<void>((resolve) => {
      firstLine = resolve;
    });

    const server = await koreServer({
      kompiledDir: WORKSPACE,
      moduleName: "TEST",
      command: FAKE_COMMAND,
      onLog: (line, stream) => {
        lines.push([stream, line]);
        if (lines.length >= 2) firstLine();
      },
    });

    try {
      expect(server.pid).toBeGreaterThan(0);
      expect(server.host).toBe("127.0.0.1");
      // The allocated port is a real one — never the `0` pyk passes.
      expect(server.port).toBeGreaterThan(0);
      expect(server.port).toBeLessThanOrEqual(65535);

      await sawOutput;
      const stdout = lines.filter(([stream]) => stream === "stdout").map(([, line]) => line);
      expect(lines.map(([stream]) => stream).toSorted()).toEqual(["stderr", "stdout"]);
      // The command really was assembled and really was passed through.
      expect(stdout[0]).toContain("--server-port");
      expect(stdout[0]).toContain(String(server.port));
      expect(stdout[0]).toContain("--module TEST");
    } finally {
      await server.close();
    }
  });

  test("close is idempotent and resolves once the process is gone", async () => {
    const server = await koreServer({ kompiledDir: WORKSPACE, moduleName: "TEST", command: FAKE_COMMAND });
    await server.close();
    await server.close();
    expect(server.pid).toBeGreaterThan(0);
  });

  test("an explicit port is used verbatim", async () => {
    const server = await koreServer({
      kompiledDir: WORKSPACE,
      moduleName: "TEST",
      port: 45678,
      command: FAKE_COMMAND,
    });
    try {
      expect(server.port).toBe(45678);
    } finally {
      await server.close();
    }
  });

  test("a missing kompiled directory is rejected before anything is spawned", async () => {
    const failure = await rejection(
      koreServer({ kompiledDir: join(WORKSPACE, "nope"), moduleName: "TEST", command: FAKE_COMMAND }),
    );
    expect(failure.message).toMatch(/kompiled directory does not exist/u);
  });

  test("a directory without a definition.kore is rejected", async () => {
    const empty = mkdtempSync(join(tmpdir(), "kore-rpc-empty-"));
    try {
      const failure = await rejection(koreServer({ kompiledDir: empty, moduleName: "TEST", command: FAKE_COMMAND }));
      expect(failure.message).toMatch(/definition\.kore does not exist/u);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("an executable that does not exist rejects rather than hanging", async () => {
    const failure = await rejection(
      koreServer({
        kompiledDir: WORKSPACE,
        moduleName: "TEST",
        command: [join(WORKSPACE, "no-such-binary")],
      }),
    );
    expect(failure.message).toMatch(/Could not start/u);
  });

  test("an invalid killGraceMs throws before any process is spawned", async () => {
    // The sentinel proves validation happens before spawning: the command
    // creates the file if it runs.
    const sentinel = join(WORKSPACE, "grace-sentinel.txt");
    rmSync(sentinel, { force: true });
    const failure = await rejection(
      koreServer({
        kompiledDir: join(WORKSPACE, "definitely-not-here"),
        moduleName: "TEST",
        command: [process.execPath, "-e", `require("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "ran")`],
        killGraceMs: -1,
      }),
    );
    expect(failure).toBeInstanceOf(RangeError);
    expect(failure.message).toMatch(/non-negative killGraceMs/u);
    // Not even the path validation ran, let alone the spawn.
    expect(failure.message).not.toMatch(/does not exist/u);
    await delay(50);
    expect(existsSync(sentinel)).toBe(false);
  });

  test("close() does not hang on a grandchild that inherited the pipes", async () => {
    // The realistic shape: `kore-rpc` installed as a wrapper that starts the
    // real server in the background. The wrapper exits; the grandchild keeps
    // the stdio pipes open, so the child's `close` event never fires and a
    // shutdown that waited for it waited forever.
    const server = await koreServer({
      kompiledDir: WORKSPACE,
      moduleName: "TEST",
      command: ["/bin/sh", "-c", "sleep 30 & wait"],
      killGraceMs: 300,
    });
    const started = Date.now();
    await server.close();
    const elapsed = Date.now() - started;
    // Comfortably under `killGraceMs + 1s`, which is what a hang would blow past.
    expect(elapsed).toBeLessThan(1300);
  });

  test("`exited` resolves with the exit code of a server that dies immediately", async () => {
    const server = await koreServer({
      kompiledDir: WORKSPACE,
      moduleName: "TEST",
      command: [process.execPath, "-e", "process.exit(1)"],
    });
    const exit = await server.exited;
    expect(exit.code).toBe(1);
    expect(exit.signal).toBeNull();
    // And closing a corpse is still a resolved promise, not a wait.
    await server.close();
  });

  test("`exited` can be raced against a connect that would otherwise burn its timeout", async () => {
    const server = await koreServer({
      kompiledDir: WORKSPACE,
      moduleName: "TEST",
      command: [process.execPath, "-e", "process.exit(3)"],
    });
    const outcome = await Promise.race([
      server.exited.then((exit) => `exited ${String(exit.code)}`),
      delay(2000).then(() => "still waiting"),
    ]);
    expect(outcome).toBe("exited 3");
    await server.close();
  });
});

describe("koreRpcServer", () => {
  test("without llvmKompiledDir it is the legacy server", async () => {
    const server = await koreRpcServer({ kompiledDir: WORKSPACE, moduleName: "TEST", command: FAKE_COMMAND });
    try {
      expect(server.pid).toBeGreaterThan(0);
    } finally {
      await server.close();
    }
  });

  test("with llvmKompiledDir it is the booster — proved by the booster-only validation", async () => {
    // The llvm directory is missing, so the *booster's* validator is what
    // fails; the legacy path never looks at it. That is the whole selection
    // rule (`rpc.py:1591-1601`), observable without an llvm build.
    const failure = await rejection(
      koreRpcServer({
        kompiledDir: WORKSPACE,
        moduleName: "TEST",
        command: FAKE_COMMAND,
        llvmKompiledDir: join(WORKSPACE, "no-llvm"),
      }),
    );
    expect(failure.message).toMatch(/llvm kompiled directory does not exist/u);
  });

  test("boosterServer validates the interpreter library and the decision tree", async () => {
    // The directory exists but holds none of the three things a booster needs.
    const failure = await rejection(
      boosterServer({
        kompiledDir: WORKSPACE,
        moduleName: "TEST",
        command: FAKE_COMMAND,
        llvmKompiledDir: WORKSPACE,
        platform: "linux",
      }),
    );
    expect(failure.message).toMatch(/llvm interpreter library does not exist/u);
  });
});
