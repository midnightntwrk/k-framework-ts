/**
 * `src/proc.ts` against real child processes.
 *
 * The children are `bash -c '…'` one-liners.  That is not "needing K": bash is
 * a POSIX given, the scripts are three words long, and the alternative —
 * mocking `child_process` — would test the mock rather than the semantics this
 * module exists to reproduce (line-wise tee, always-capture, DEVNULL stdin,
 * `check` throwing with both streams attached).
 *
 * Nothing here compiles a definition or looks for K.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { caughtAsync } from "./caught.ts";
import {
  absOrRelTo,
  checkDirPath,
  checkFilePath,
  formatCommand,
  ProcessError,
  ProcessAbortError,
  ProcessCancelledError,
  runProcess,
  signalNumber,
} from "../src/proc.ts";

const scratchDirs: string[] = [];

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ktool-proc-"));
  scratchDirs.push(dir);
  return dir;
}

async function processExists(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return !(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ESRCH"
    );
  }
}

async function eventuallyGone(pid: number, withinMs = 1_000): Promise<boolean> {
  const until = Date.now() + withinMs;
  while (Date.now() < until) {
    if (!(await processExists(pid))) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  return !(await processExists(pid));
}

afterEach(async () => {
  await Promise.all(scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** `bash -c <script>` — the whole of this file's process vocabulary. */
const sh = (script: string): readonly string[] => ["bash", "-c", script];

describe("runProcess", () => {
  test("captures stdout and stderr separately, in full", async () => {
    const result = await runProcess(sh("echo out; echo err >&2; echo out2"));
    expect(result.stdout).toBe("out\nout2\n");
    expect(result.stderr).toBe("err\n");
    expect(result.returncode).toBe(0);
    expect(result.signal).toBeUndefined();
    expect(result.args).toEqual(["bash", "-c", "echo out; echo err >&2; echo out2"]);
  });

  test("a non-zero exit throws ProcessError carrying argv, status and both streams", async () => {
    const error = await caughtAsync(runProcess(sh("echo o; echo e >&2; exit 3")), ProcessError);
    expect(error.returncode).toBe(3);
    expect(error.stdout).toBe("o\n");
    expect(error.stderr).toBe("e\n");
    expect(error.args).toEqual(["bash", "-c", "echo o; echo e >&2; exit 3"]);
    // stderr is in the message because that is the field every caller reaches
    // for after catching one.
    expect(error.message).toContain("status 3");
    expect(error.message).toContain("e");
    expect(error.name).toBe("ProcessError");
  });

  test("check: false returns the failure instead of throwing", async () => {
    const result = await runProcess(sh("exit 7"), { check: false });
    expect(result.returncode).toBe(7);
  });

  test("check defaults to true", async () => {
    expect(runProcess(sh("exit 1"))).rejects.toBeInstanceOf(ProcessError);
  });

  test("input is written to stdin and the pipe is closed", async () => {
    const result = await runProcess(sh("cat"), { input: "hello\nworld\n" });
    expect(result.stdout).toBe("hello\nworld\n");
  });

  test("with no input, stdin is /dev/null and reads hit EOF immediately", async () => {
    // `stdin=DEVNULL` (`utils.py:545`).  If stdin were inherited this would
    // block on the test runner's terminal, or read the runner's own input.
    const result = await runProcess(sh("cat; echo done"));
    expect(result.stdout).toBe("done\n");
  });

  test("a child that never reads stdin does not make the write fail", async () => {
    // EPIPE, swallowed exactly as pyk's `_stdin_write` swallows it: the status
    // the child exited with is the interesting failure, not the write.
    const result = await runProcess(sh("exit 0"), { input: "x".repeat(200_000), check: false });
    expect(result.returncode).toBe(0);
  });

  test("cwd is where the child runs", async () => {
    const dir = await scratch();
    const result = await runProcess(sh("pwd"), { cwd: dir });
    // macOS symlinks /tmp, so compare the basename rather than the whole path.
    expect(result.stdout.trim().endsWith(dir.split("/").pop() ?? "")).toBe(true);
  });

  test("a cwd that is not a directory is reported before the spawn", async () => {
    const error = await caughtAsync(runProcess(sh("true"), { cwd: "/no/such/directory" }), Error);
    expect(error.message).toContain("Directory does not exist");
  });

  test("env replaces the environment rather than merging into it", async () => {
    const result = await runProcess(sh('echo "[$KTOOL_MARKER][$HOME]"'), {
      env: { KTOOL_MARKER: "set", PATH: process.env["PATH"] ?? "" },
    });
    expect(result.stdout).toBe("[set][]\n");
  });

  test("an executable that does not exist rejects, and not with a ProcessError", async () => {
    // Python raises `FileNotFoundError` here, which is not `CalledProcessError`;
    // the distinction matters because "could not start" is not "exited badly".
    // The wording is the runtime's (Node says ENOENT, Bun names $PATH), so only
    // the class and the offending name are asserted.
    const error = await caughtAsync(runProcess(["ktool-no-such-binary-9f3a"]), Error);
    expect(error).not.toBeInstanceOf(ProcessError);
    expect(error.message).toContain("ktool-no-such-binary-9f3a");
  });

  test("an empty argv is rejected before anything is spawned", async () => {
    expect(runProcess([])).rejects.toThrow("Cannot run an empty command");
  });

  test("a signal death reports Python's -signum, and the name Node knew", async () => {
    // Node gives `code === null` + `'SIGTERM'`; POSIX `wait`, and so
    // `subprocess`, gives `-15`.  `returncode !== 0` must mean the same in both.
    const result = await runProcess(sh("kill -TERM $$"), { check: false });
    expect(result.signal).toBe("SIGTERM");
    expect(result.returncode).toBe(-signalNumber("SIGTERM"));
    expect(result.returncode).toBeLessThan(0);
  });

  test("timeout is a distinct completed cancellation when check is false", async () => {
    const result = await runProcess(sh("echo before; sleep 30"), { timeoutMs: 30, killGraceMs: 0, check: false });
    expect(result.cancelledBy).toBe("timeout");
    expect(result.stdout).toContain("before");
  });

  test("timeout kills a wrapper's process group and cannot wait on a pipe-holding descendant", async () => {
    const started = Date.now();
    const result = await runProcess(sh("sleep 30 & echo child:$!; wait"), {
      timeoutMs: 30,
      killGraceMs: 0,
      check: false,
    });
    expect(result.cancelledBy).toBe("timeout");
    expect(result.stdout).toMatch(/^child:\d+\n/u);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("a deadline after the leader exited releases pipe-holding descendants without rewriting its success", async () => {
    const dir = await scratch();
    const childFile = join(dir, "pipe-holder");
    const started = Date.now();
    try {
      const result = await runProcess(sh(`sleep 30 & echo $! > ${childFile}; exit 0`), {
        timeoutMs: 30,
        check: false,
      });
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(result).toMatchObject({ returncode: 0, signal: undefined, cancelledBy: undefined });
    } finally {
      try {
        const child = Number((await (await import("node:fs/promises")).readFile(childFile, "utf8")).trim());
        if (Number.isInteger(child)) process.kill(child, "SIGKILL");
      } catch {
        // The leader may be interrupted before it records the descendant PID.
      }
    }
  });

  test("TERM reaches a child and grandchild in the detached group", async () => {
    const dir = await scratch();
    const pids = join(dir, "pids");
    const result = await runProcess(sh(`(sleep 30 & echo $! >> ${pids}; wait) & echo $! >> ${pids}; wait`), {
      timeoutMs: 30,
      killGraceMs: 20,
      check: false,
    });
    expect(result.cancelledBy).toBe("timeout");
    const [child, grandchild] = (await (await import("node:fs/promises")).readFile(pids, "utf8"))
      .trim()
      .split("\n")
      .map(Number);
    expect(await eventuallyGone(child!)).toBe(true);
    expect(await eventuallyGone(grandchild!)).toBe(true);
  });

  test("cancellation retains partial output from both pipes", async () => {
    const result = await runProcess(sh("printf out; printf err >&2; sleep 30"), {
      timeoutMs: 30,
      killGraceMs: 0,
      check: false,
    });
    expect(result).toMatchObject({ cancelledBy: "timeout", stdout: "out", stderr: "err" });
    // A leader exit is observable on this host; the important invariant is
    // that a forced settlement *may* omit it, never that it must omit it.
    expect(result.returncode === undefined || result.returncode < 0).toBe(true);
  });

  test("a clean exit during TERM grace is observed rather than fabricated", async () => {
    const result = await runProcess(sh("trap 'exit 0' TERM; while :; do sleep 1; done"), {
      timeoutMs: 30,
      killGraceMs: 200,
      check: false,
    });
    expect(result.cancelledBy).toBe("timeout");
    expect(result.returncode).toBe(0);
    expect(result.signal).toBeUndefined();
  });

  test("never reuses a departed leader's process-group id for KILL", async () => {
    const dir = await scratch();
    const childFile = join(dir, "term-ignoring-child");
    const originalKill = process.kill.bind(process);
    let groupSignals = 0;
    process.kill = (pid: number, signal?: NodeJS.Signals | number) => {
      if (pid < 0) groupSignals += 1;
      return originalKill(pid, signal);
    };
    try {
      const result = await runProcess(sh(`trap '' TERM; sleep 30 & echo $! > ${childFile}; trap 'exit 0' TERM; wait`), {
        timeoutMs: 30,
        killGraceMs: 100,
        check: false,
      });
      expect(result.returncode).toBe(0);
      // TERM was delivered while the leader lived. Its clean exit cancels the
      // KILL timer: `-pid` must never be used after that pid may be reused.
      expect(groupSignals).toBe(1);
    } finally {
      process.kill = originalKill;
      try {
        const child = Number((await (await import("node:fs/promises")).readFile(childFile, "utf8")).trim());
        if (Number.isInteger(child)) originalKill(child, "SIGKILL");
      } catch {
        // The test child may have died before it wrote its PID.
      }
    }
  });

  test("a failed POSIX group signal degrades to the direct child", async () => {
    const originalKill = process.kill.bind(process);
    const logs: string[] = [];
    process.kill = (pid: number, signal?: NodeJS.Signals | number) => {
      if (pid < 0) {
        const error = Object.assign(new Error("denied"), { code: "EPERM" });
        throw error;
      }
      return originalKill(pid, signal);
    };
    try {
      const result = await runProcess(sh("sleep 30"), {
        timeoutMs: 30,
        killGraceMs: 0,
        check: false,
        logger: (line) => logs.push(line),
      });
      expect(result.cancelledBy).toBe("timeout");
      expect(logs.some((line) => line.includes("group SIGTERM failed (EPERM); falling back to child"))).toBe(true);
    } finally {
      process.kill = originalKill;
    }
  });

  test("zero grace escalates without waiting through the default two seconds", async () => {
    const started = Date.now();
    const result = await runProcess(sh("trap '' TERM; sleep 30"), { timeoutMs: 30, killGraceMs: 0, check: false });
    expect(result.cancelledBy).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(500);
  });

  test("zero grace delivers group TERM and KILL in the aborting turn", async () => {
    const controller = new AbortController();
    const originalKill = process.kill.bind(process);
    const signals: NodeJS.Signals[] = [];
    process.kill = (pid: number, signal?: NodeJS.Signals | number) => {
      if (pid < 0 && typeof signal === "string") signals.push(signal);
      return originalKill(pid, signal);
    };
    try {
      const pending = runProcess(sh("trap '' TERM; sleep 30"), {
        signal: controller.signal,
        killGraceMs: 0,
        check: false,
      });
      controller.abort();
      expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
      await pending;
    } finally {
      process.kill = originalKill;
    }
  });

  test("abort and timeout remain distinct typed errors", async () => {
    const controller = new AbortController();
    const pending = runProcess(sh("sleep 30"), { signal: controller.signal, killGraceMs: 0 });
    controller.abort();
    const error = await caughtAsync(pending, ProcessCancelledError);
    expect(error.cancelledBy).toBe("abort");
  });

  test("check chooses a typed cancellation throw or the same returned result", async () => {
    const returned = await runProcess(sh("sleep 30"), { timeoutMs: 30, killGraceMs: 0, check: false });
    expect(returned.cancelledBy).toBe("timeout");
    const error = await caughtAsync(
      runProcess(sh("sleep 30"), { timeoutMs: 30, killGraceMs: 0 }),
      ProcessCancelledError,
    );
    expect(error.cancelledBy).toBe("timeout");
    expect(error.returncode === undefined || error.returncode < 0).toBe(true);
  });

  test("an abort raced immediately after spawn is still cancellation, never a normal result", async () => {
    const controller = new AbortController();
    const pending = runProcess(sh("echo spawned; sleep 30"), {
      signal: controller.signal,
      killGraceMs: 0,
      check: false,
    });
    controller.abort();
    const result = await pending;
    expect(result.cancelledBy).toBe("abort");
  });

  test("a normal settlement removes the abort listener and deadline", async () => {
    const controller = new AbortController();
    const signal = controller.signal;
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    let added = 0;
    let removed = 0;
    signal.addEventListener = (...args: Parameters<typeof add>) => {
      added += 1;
      add(...args);
    };
    signal.removeEventListener = (...args: Parameters<typeof remove>) => {
      removed += 1;
      remove(...args);
    };
    try {
      const result = await runProcess(sh("exit 0"), { signal, timeoutMs: 50, check: false });
      expect(result).toMatchObject({ returncode: 0, cancelledBy: undefined });
      expect(added).toBe(1);
      expect(removed).toBe(1);
      await new Promise<void>((resolve) => setTimeout(resolve, 70));
      expect(result.cancelledBy).toBeUndefined();
    } finally {
      signal.addEventListener = add;
      signal.removeEventListener = remove;
    }
  });

  test("a pre-aborted signal rejects before spawning", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(runProcess(sh("touch should-not-exist"), { signal: controller.signal })).rejects.toBeInstanceOf(
      ProcessAbortError,
    );
  });

  test("invalid control durations are rejected", async () => {
    expect(runProcess(sh("true"), { timeoutMs: 0 })).rejects.toThrow("timeoutMs");
    expect(runProcess(sh("true"), { killGraceMs: -1 })).rejects.toThrow("killGraceMs");
  });
});

describe("the logger", () => {
  test("emits pyk's [exec], [stdo], [stde] and [done] records", async () => {
    const lines: string[] = [];
    await runProcess(sh("echo one; echo two >&2"), { logger: (m) => lines.push(m) });

    const kinds = lines.map((line) => line.replace(/^\[PID=[^\]]+\]/u, "").split(" ")[0] ?? "");
    // `[exec]` first and `[done]` last are ordering guarantees — they bracket
    // the run.  The two output records in between are **not** ordered against
    // each other: stdout and stderr are separate pipes read by separate
    // readers, so which of two nearly simultaneous lines is delivered first is
    // a scheduling accident under load.  pyk makes no cross-pipe promise
    // either: `_subprocess_communicate` (`utils.py:580-640`) logs `[stdo]` and
    // `[stde]` from two daemon reader *threads* it starts and only joins at the
    // end, so their records interleave however the OS schedules them.
    // Asserting a strict four-element order was testing the scheduler.
    expect(kinds[0]).toBe("[exec]");
    expect(kinds.at(-1)).toBe("[done]");
    expect(kinds.slice(1, -1).toSorted((left, right) => left.localeCompare(right))).toEqual(["[stde]", "[stdo]"]);
    expect(lines[0]).toContain("bash -c 'echo one; echo two >&2'");
    expect(lines.filter((line) => line.endsWith("[stdo] one"))).toHaveLength(1);
    expect(lines.filter((line) => line.endsWith("[stde] two"))).toHaveLength(1);
    expect(lines.at(-1)).toContain("[done] status=0 time=");
  });

  test("logs one record per line of input, before the write", async () => {
    const lines: string[] = [];
    await runProcess(sh("cat > /dev/null"), { input: "a\nb", logger: (m) => lines.push(m) });
    expect(lines.filter((l) => l.includes("[stdi]"))).toHaveLength(2);
  });

  test("is silent by default — a library that writes to the terminal uninvited is one you work around", async () => {
    // Nothing to assert but the absence of a default sink; this is the
    // documented divergence from pyk's module-level `logging.Logger`.
    await runProcess(sh("echo x"));
  });
});

/**
 * Swap `process.stdout.write` (or stderr's) for a collector while `body` runs,
 * and return what was written to it.  Restored in `finally`, always: leaving
 * the runner's own stdout replaced would take the rest of the suite with it.
 */
async function capturing(stream: "stdout" | "stderr", body: () => Promise<void>): Promise<string> {
  const target = process[stream];
  const original = target.write.bind(target);
  const chunks: string[] = [];
  target.write = (chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  };
  try {
    await body();
  } finally {
    target.write = original;
  }
  return chunks.join("");
}

describe("the tee", () => {
  test("teeStdout mirrors onto the parent's stdout while still capturing", async () => {
    let captured = "";
    const mirrored = await capturing("stdout", async () => {
      captured = (await runProcess(sh("echo a; echo b"), { teeStdout: true })).stdout;
    });
    expect(mirrored).toBe("a\nb\n");
    expect(captured).toBe("a\nb\n");
  });

  test("teeStderr does the same for stderr, and leaves stdout alone", async () => {
    const mirrored = await capturing("stderr", async () => {
      await runProcess(sh("echo out; echo err >&2"), { teeStderr: true });
    });
    expect(mirrored).toBe("err\n");
  });

  test("a trailing fragment with no newline is still flushed", async () => {
    // Python's file iteration yields the final partial line; a tee that only
    // emitted on `\n` would silently drop a prompt.
    const mirrored = await capturing("stdout", async () => {
      await runProcess(sh("printf 'no-newline'"), { teeStdout: true });
    });
    expect(mirrored).toBe("no-newline");
  });

  test("without the flags nothing reaches the parent's streams", async () => {
    const mirrored = await capturing("stdout", async () => {
      await runProcess(sh("echo quiet"));
    });
    expect(mirrored).toBe("");
  });
});

describe("formatCommand", () => {
  test("is shlex.join — for logs only, never for running", () => {
    expect(formatCommand(["kompile", "imp.k"])).toBe("kompile imp.k");
    expect(formatCommand(["echo", "a b"])).toBe("echo 'a b'");
    expect(formatCommand(["echo", ""])).toBe("echo ''");
    expect(formatCommand(["echo", "it's"])).toBe(`echo 'it'"'"'s'`);
    expect(formatCommand(["kompile", "--md-selector", "k & ! node"])).toBe("kompile --md-selector 'k & ! node'");
  });
});

describe("path predicates", () => {
  test("checkDirPath accepts a directory and names the resolved path otherwise", async () => {
    const dir = await scratch();
    await checkDirPath(dir);

    const missing = await caughtAsync(checkDirPath(join(dir, "nope")), Error);
    expect(missing.message).toBe(`Directory does not exist: ${join(dir, "nope")}`);

    const file = join(dir, "f.k");
    await writeFile(file, "");
    const notDir = await caughtAsync(checkDirPath(file), Error);
    expect(notDir.message).toBe(`Path is not a directory: ${file}`);
  });

  test("checkFilePath is the same, for regular files", async () => {
    const dir = await scratch();
    const file = join(dir, "f.k");
    await writeFile(file, "module F endmodule");
    await checkFilePath(file);

    const missing = await caughtAsync(checkFilePath(join(dir, "nope.k")), Error);
    expect(missing.message).toBe(`File does not exist: ${join(dir, "nope.k")}`);

    const notFile = await caughtAsync(checkFilePath(dir), Error);
    expect(notFile.message).toBe(`Path is not a file: ${dir}`);
  });

  test("absOrRelTo leaves an absolute path alone and anchors a relative one", () => {
    expect(absOrRelTo("/etc/hosts", "/base")).toBe("/etc/hosts");
    expect(absOrRelTo("imp.k", "/base")).toBe("/base/imp.k");
    expect(absOrRelTo("sub/imp.k", ".")).toBe("sub/imp.k");
  });
});
