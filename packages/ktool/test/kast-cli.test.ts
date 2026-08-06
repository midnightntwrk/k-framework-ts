/**
 * The `kast` argv golden table, the two `--gen-glr-parser` preconditions, and
 * the 128 KiB expression switch.
 *
 * Upstream has **no** test for any of this — `_build_arg_list`
 * (`ktool/kprint.py:136-168`) and `_expression_kast` (`:314-353`) are covered
 * only indirectly, by integration tests that need a real toolchain.  So the
 * table below is new, and it is written in the same shape as the ported
 * `test_krun.py` one next door: one row per flag, every row alone, and one row
 * with all of them, so that a change to an emission position fails loudly
 * instead of quietly.
 *
 * The threshold cases spawn nothing.  {@link ProcessRunner} is injected, so
 * what is asserted is the *decision* — `--expression` versus a positional temp
 * file — and not the behaviour of a `kast` that may not be installed.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { caughtAsync } from "./caught.ts";
import {
  EXPRESSION_MAX_LENGTH,
  expressionKast,
  genGlrParser,
  KAST_INPUTS,
  KAST_OUTPUTS,
  kastArgs,
  runKast,
  withTempFile,
  type KastArgs,
} from "../src/kast-cli.ts";
import type { ProcessRunner } from "../src/kore-print.ts";

//////////////////////////////
// The table                //
//////////////////////////////

interface Row {
  readonly id: string;
  readonly apply: (args: KastArgs) => KastArgs;
  readonly expected: readonly string[];
}

/** One row per `if` in `_build_arg_list` (`ktool/kprint.py:149-168`), in that order. */
const ROWS: readonly Row[] = [
  { id: "file", apply: (a) => ({ ...a, file: "input/path" }), expected: ["input/path"] },
  { id: "definitionDir", apply: (a) => ({ ...a, definitionDir: "def/path" }), expected: ["--definition", "def/path"] },
  { id: "input", apply: (a) => ({ ...a, input: "program" }), expected: ["--input", "program"] },
  { id: "output", apply: (a) => ({ ...a, output: "json" }), expected: ["--output", "json"] },
  { id: "expression", apply: (a) => ({ ...a, expression: "3 + 4" }), expected: ["--expression", "3 + 4"] },
  { id: "module", apply: (a) => ({ ...a, module: "IMP" }), expected: ["--module", "IMP"] },
  { id: "sort", apply: (a) => ({ ...a, sort: "AExp" }), expected: ["--sort", "AExp"] },
  { id: "tempDir", apply: (a) => ({ ...a, tempDir: "/tmp/path" }), expected: ["--temp-dir", "/tmp/path"] },
  { id: "genGlrParser", apply: (a) => ({ ...a, genGlrParser: true }), expected: ["--gen-glr-parser"] },
];

describe("kastArgs — the golden table (untested upstream)", () => {
  test("nothing but the command", () => {
    expect(kastArgs()).toEqual(["kast"]);
    expect(kastArgs({})).toEqual(["kast"]);
  });

  test("every flag at once, in emission order", () => {
    const args = ROWS.reduce<KastArgs>((acc, row) => row.apply(acc), {});
    expect(kastArgs(args)).toEqual(["kast", ...ROWS.flatMap((row) => row.expected)]);
  });

  for (const row of ROWS) {
    test(`${row.id}: alone`, () => {
      expect(kastArgs(row.apply({}))).toEqual(["kast", ...row.expected]);
    });
  }

  test("the enums carry upstream's members (`kprint.py:39-56`)", () => {
    expect(KAST_INPUTS).toEqual(["program", "binary", "json", "kast", "kore", "rule"]);
    expect(KAST_OUTPUTS).toEqual(["pretty", "program", "kast", "binary", "json", "latex", "kore", "none"]);
  });

  test("the command is a whole prefix", () => {
    expect(kastArgs({ command: ["kevm", "kast"], output: "kore" })).toEqual(["kevm", "kast", "--output", "kore"]);
  });

  test("an empty string is absent, as pyk's truthiness makes it", () => {
    expect(kastArgs({ file: "", expression: "", module: "", sort: "", definitionDir: "", tempDir: "" })).toEqual([
      "kast",
    ]);
  });

  test("the positional file comes before every flag, --gen-glr-parser included", () => {
    expect(kastArgs({ file: "out/parser", genGlrParser: true, definitionDir: "d" })).toEqual([
      "kast",
      "out/parser",
      "--definition",
      "d",
      "--gen-glr-parser",
    ]);
  });
});

//////////////////////////////
// Preconditions            //
//////////////////////////////

/** A {@link ProcessRunner} that records every argv and answers with `stdout`. */
function recorder(calls: (readonly string[])[], stdout = ""): ProcessRunner {
  return async (args) => {
    calls.push([...args]);
    return { args, returncode: 0, stdout, stderr: "", signal: undefined };
  };
}

describe("runKast's preconditions — `_kast` (`kprint.py:74-85`)", () => {
  test("--gen-glr-parser with no file is refused here, not by the child", async () => {
    const error = await caughtAsync(runKast({ genGlrParser: true }), Error);
    expect(error.message).toBe("No output file specified for --gen-glr-parser");
  });

  test("genGlrParser() with no file is the same refusal", async () => {
    const error = await caughtAsync(genGlrParser(""), Error);
    expect(error.message).toBe("No output file specified for --gen-glr-parser");
  });

  test("an input file must exist — but a --gen-glr-parser *output* need not", async () => {
    const absent = join(tmpdir(), "ktool-absent-input.k");
    const error = await caughtAsync(runKast({ file: absent }), Error);
    expect(error.message).toMatch(/File does not exist/u);

    // The same non-existent path with `genGlrParser` gets past the check and
    // reaches the runner, because it is where the parser will be *written*.
    const calls: (readonly string[])[] = [];
    await runKast({ file: absent, genGlrParser: true, runner: recorder(calls) });
    expect(calls[0]).toEqual(["kast", absent, "--gen-glr-parser"]);
  });

  test("a missing definition directory is reported before the spawn", async () => {
    const error = await caughtAsync(runKast({ definitionDir: join(tmpdir(), "ktool-absent-dir") }), Error);
    expect(error.message).toMatch(/Directory does not exist/u);
  });

  test("genGlrParser throws when the run succeeded but wrote nothing", async () => {
    const target = join(tmpdir(), "ktool-parser-never-written");
    const error = await caughtAsync(genGlrParser(target, { runner: recorder([]) }), Error);
    expect(error.message).toMatch(/File does not exist/u);
  });

  test("genGlrParser returns the path when the file is there", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ktool-glr-"));
    try {
      const target = join(dir, "parser");
      const runner: ProcessRunner = async (args) => {
        await writeFile(target, "#!/bin/sh\n");
        return { args, returncode: 0, stdout: "", stderr: "", signal: undefined };
      };
      expect(await genGlrParser(target, { runner, module: "IMP", sort: "Pgm" })).toBe(target);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

//////////////////////////////
// The 128 KiB switch       //
//////////////////////////////

describe("expressionKast — the 128 KiB threshold (`kprint.py:326`)", () => {
  test("the constant is 128 * 1024 characters", () => {
    expect(EXPRESSION_MAX_LENGTH).toBe(131072);
  });

  test("one character under the limit goes in the argv", async () => {
    const calls: (readonly string[])[] = [];
    const expression = "x".repeat(EXPRESSION_MAX_LENGTH - 1);
    await expressionKast(expression, { input: "json", output: "kore", runner: recorder(calls) });

    expect(calls[0]).toEqual(["kast", "--input", "json", "--output", "kore", "--expression", expression]);
  });

  test("exactly the limit goes in a file — the comparison is `<`, not `<=`", async () => {
    const calls: (readonly string[])[] = [];
    const expression = "x".repeat(EXPRESSION_MAX_LENGTH);
    await expressionKast(expression, { input: "json", output: "kore", runner: recorder(calls) });

    const argv = calls[0] ?? [];
    expect(argv).not.toContain("--expression");
    // `[kast, <file>, --input, json, --output, kore]` — the file is positional.
    expect(argv[1]).toMatch(/ktool-/u);
    expect(argv.slice(2)).toEqual(["--input", "json", "--output", "kore"]);
  });

  test("the file's contents are the expression, and it is gone afterwards", async () => {
    let seen: { readonly path: string; readonly text: string } | undefined;
    const runner: ProcessRunner = async (args) => {
      const path = args[1] ?? "";
      seen = { path, text: await Bun.file(path).text() };
      return { args, returncode: 0, stdout: "", stderr: "", signal: undefined };
    };

    await expressionKast("the term", { forceTempFile: true, runner });

    expect(seen?.text).toBe("the term");
    expect(await Bun.file(seen?.path ?? "").exists()).toBe(false);
  });

  test("a configured useDirectory keeps the file *and* becomes --temp-dir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ktool-expr-"));
    try {
      const calls: (readonly string[])[] = [];
      await expressionKast("the term", { forceTempFile: true, useDirectory: dir, runner: recorder(calls) });

      expect(calls[0]?.slice(2)).toEqual(["--temp-dir", dir]);
      expect(await readdir(dir)).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("--temp-dir is emitted on the short path too, where no file is written", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ktool-expr-"));
    try {
      const calls: (readonly string[])[] = [];
      await expressionKast("small", { useDirectory: dir, runner: recorder(calls) });

      expect(calls[0]).toEqual(["kast", "--expression", "small", "--temp-dir", dir]);
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("withTempFile — `KPrint._temp_file` (`kprint.py:206-216`)", () => {
  test("cleans up even when the body throws", async () => {
    let path = "";
    await caughtAsync(
      withTempFile("contents", {}, async (p) => {
        path = p;
        throw new Error("boom");
      }),
      Error,
    );
    expect(path).not.toBe("");
    expect(await Bun.file(path).exists()).toBe(false);
  });

  test("a useDirectory that does not exist is refused before anything is written", async () => {
    const error = await caughtAsync(
      withTempFile("x", { useDirectory: join(tmpdir(), "ktool-absent-dir") }, async (p) => p),
      Error,
    );
    expect(error.message).toMatch(/Directory does not exist/u);
  });

  test("two concurrent calls do not collide", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ktool-temp-"));
    try {
      await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          withTempFile(String(i), { useDirectory: dir }, async (p) => Bun.file(p).text()),
        ),
      );
      expect(await readdir(dir)).toHaveLength(8);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
