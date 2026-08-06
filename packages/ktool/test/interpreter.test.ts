/**
 * `llvmInterpret` / `llvmInterpretRaw` — the argv, and the whole spawn → parse
 * path against a **fake interpreter**.
 *
 * The real `interpreter` is a native binary `kompile --backend llvm` emits, and
 * the fixture directories in this repo do not carry one (it is tens of
 * megabytes).  But nothing about this wrapper depends on the binary being real:
 * it hands KORE to a process and parses what comes back.  So each test writes a
 * three-line shell script called `interpreter` into a scratch directory and
 * runs against that — which exercises `runProcess`, the temp-file delivery,
 * the exit-status handling and the KORE parse, with no K anywhere.
 *
 * # Read `src/stdio.ts` before this file
 *
 * pyk's argv is `interpreter /dev/stdin <depth> /dev/stdout` and the KORE goes
 * down the pipe.  A child spawned by Node or Bun **cannot open either path** —
 * both runtimes hand it a socketpair, and reopening a socket through `/proc` is
 * `ENXIO` — so `llvmInterpretRaw` writes the term to a temp file, gives the
 * child a second temp file to write into, and reports that file's contents as
 * `stdout`.  The fakes below therefore read `$1` rather than stdin.  They still
 * *write* to their own stdout, which is deliberate: `llvmInterpretRaw` falls
 * back to the child's stdout when the output file is empty, and these tests are
 * what pin that fallback.
 *
 * That is also why the failure cases are worth having: an interpreter that
 * exits 0 and prints nothing is a *real* symptom (a pattern the definition
 * cannot start from), and it is the one upstream turned into its own
 * `RuntimeError` (`krun.py:448-449`).
 */

import { describe, expect, test } from "bun:test";
import { app, koreText, sortApp } from "@kframework-ts/kore";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { caughtAsync } from "./caught.ts";
import { InterpreterError, llvmInterpret, llvmInterpretArgs, llvmInterpretRaw } from "../src/interpreter.ts";
import { ProcessError } from "../src/proc.ts";

// A quote-free symbol on purpose: the fake interpreter is a shell script,
// and `Lbl'-LT-'k'-GT-'` cannot survive a single-quoted `printf` argument.
const PATTERN = app("Lblfoo", [], [app("dotk", [sortApp("SortK")], [])]);

/** A scratch directory holding an executable `interpreter` with the given body. */
async function fakeDefinition(body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ktool-interp-"));
  const path = join(dir, "interpreter");
  await writeFile(path, `#!/usr/bin/env bash\n${body}\n`, "utf8");
  await chmod(path, 0o755);
  return dir;
}

async function withFake<T>(body: string, use: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fakeDefinition(body);
  try {
    return await use(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

//////////////////////////////
// The argv                 //
//////////////////////////////

describe("llvmInterpretArgs — `llvm_interpret_raw`'s list (`krun.py:476`)", () => {
  test("interpreter, /dev/stdin, depth, /dev/stdout", () => {
    expect(llvmInterpretArgs("imp-kompiled", 7)).toEqual([
      join("imp-kompiled", "interpreter"),
      "/dev/stdin",
      "7",
      "/dev/stdout",
    ]);
  });

  test("no depth is -1, the interpreter's own 'run to completion' (`:475`)", () => {
    expect(llvmInterpretArgs("d")[2]).toBe("-1");
  });

  test("depth 0 is a real request and is not turned into -1", () => {
    expect(llvmInterpretArgs("d", 0)[2]).toBe("0");
  });

  test("the two file paths are optional parameters that default to pyk's literals", () => {
    expect(llvmInterpretArgs("d", 1, "in.kore", "out.kore")).toEqual([
      join("d", "interpreter"),
      "in.kore",
      "1",
      "out.kore",
    ]);
  });
});

//////////////////////////////
// The spawn                //
//////////////////////////////

describe("llvmInterpretRaw — against a fake interpreter", () => {
  test("the KORE arrives in the input file, and the depth in argv[2]", async () => {
    await withFake('echo "got:$(cat "$1") depth:$2"', async (dir) => {
      const result = await llvmInterpretRaw(dir, "hello-kore", { depth: 3 });
      expect(result.returncode).toBe(0);
      expect(result.stdout.trim()).toBe("got:hello-kore depth:3");
    });
  });

  test("what the child writes to the output file is what comes back as stdout", async () => {
    await withFake("printf 'from-file\\n' > \"$3\"; echo from-stdout", async (dir) => {
      const result = await llvmInterpretRaw(dir, "x");
      expect(result.stdout).toBe("from-file\n");
    });
  });

  test("a child that writes nothing to the output file falls back to its stdout", async () => {
    // The seam that keeps every `runner`-injected unit test in this suite
    // meaningful: a fake that ignores the paths still gets its answer read.
    await withFake("echo from-stdout", async (dir) => {
      expect((await llvmInterpretRaw(dir, "x")).stdout).toBe("from-stdout\n");
    });
  });

  test("both temp files are deleted once the call returns", async () => {
    await withFake('echo "$1" > "$3"', async (dir) => {
      const result = await llvmInterpretRaw(dir, "x");
      const inputFile = result.stdout.trim();
      expect(inputFile).not.toBe("");
      expect(existsSync(inputFile)).toBe(false);
      expect(existsSync(result.args[3] ?? "")).toBe(false);
    });
  });

  test("a missing interpreter is reported before the spawn (`:473`)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ktool-interp-none-"));
    try {
      const error = await caughtAsync(llvmInterpretRaw(dir, "x"), Error);
      expect(error.message).toMatch(/File does not exist/u);
      expect(error).not.toBeInstanceOf(InterpreterError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("check defaults to true and raises the process error", async () => {
    await withFake("exit 4", async (dir) => {
      const error = await caughtAsync(llvmInterpretRaw(dir, "x"), ProcessError);
      expect(error.returncode).toBe(4);
    });
  });

  test("check: false hands the status back instead", async () => {
    await withFake("exit 4", async (dir) => {
      expect((await llvmInterpretRaw(dir, "x", { check: false })).returncode).toBe(4);
    });
  });
});

describe("llvmInterpret — the two RuntimeError shapes (`krun.py:443-451`)", () => {
  test("a successful run is parsed as one KORE pattern", async () => {
    const text = koreText(PATTERN);
    await withFake(`cat > /dev/null; printf '%s\\n' '${text}'`, async (dir) => {
      expect(await llvmInterpret(dir, PATTERN)).toEqual(PATTERN);
    });
  });

  test("a non-zero exit becomes 'Interpreter failed with status …' (`:446`)", async () => {
    await withFake('cat > /dev/null; echo "bad things" >&2; exit 2', async (dir) => {
      const error = await caughtAsync(llvmInterpret(dir, PATTERN), InterpreterError);
      expect(error.message).toBe("Interpreter failed with status 2: bad things\n");
      expect(error.returncode).toBe(2);
      expect(error.emptyOutput).toBe(false);
    });
  });

  test("an empty stdout becomes 'terminated with status … and produced no output' (`:449`)", async () => {
    await withFake('cat > /dev/null; echo "why" >&2', async (dir) => {
      const error = await caughtAsync(llvmInterpret(dir, PATTERN), InterpreterError);
      expect(error.message).toBe("Interpreter terminated with status 0 and produced no output: why\n");
      expect(error.returncode).toBe(0);
      expect(error.emptyOutput).toBe(true);
    });
  });

  test("under check: false a non-zero exit reaches the empty-output branch instead", async () => {
    // Upstream's control flow exactly: `llvm_interpret_raw` only raises under
    // `check`, so without it the *first* error message is unreachable and the
    // second one reports the non-zero status.
    await withFake("cat > /dev/null; exit 9", async (dir) => {
      const error = await caughtAsync(llvmInterpret(dir, PATTERN, { check: false }), InterpreterError);
      expect(error.emptyOutput).toBe(true);
      expect(error.returncode).toBe(9);
    });
  });

  test("the depth reaches the child", async () => {
    const text = koreText(PATTERN);
    await withFake(`cat > /dev/null; [ "$2" = "5" ] && printf '%s\\n' '${text}'`, async (dir) => {
      expect(await llvmInterpret(dir, PATTERN, { depth: 5 })).toEqual(PATTERN);
      await caughtAsync(llvmInterpret(dir, PATTERN, { depth: 6 }), InterpreterError);
    });
  });

  test("an injected runner sees the argv without any process at all", async () => {
    const calls: (readonly string[])[] = [];
    await withFake("true", async (dir) => {
      await llvmInterpret(dir, PATTERN, {
        runner: (args) => {
          calls.push([...args]);
          return Promise.resolve({ args, returncode: 0, stdout: koreText(PATTERN), stderr: "", signal: undefined });
        },
      });
      // The two `/dev/*` literals are gone from the *spawn*; they remain the
      // defaults of `llvmInterpretArgs`, which the golden above pins.
      const argv = calls[0] ?? [];
      expect(argv[0]).toBe(join(dir, "interpreter"));
      expect(argv[1]).toMatch(/interpreter-in-.*\.kore$/u);
      expect(argv[2]).toBe("-1");
      expect(argv[3]).toMatch(/interpreter-out-.*\.kore$/u);
      expect(llvmInterpretArgs(dir, undefined, argv[1], argv[3])).toEqual([...argv]);
    });
  });
});
