/**
 * `kore-print`: the argv table, the `--output kore` short-circuit, and the
 * `--output-file` divergence.
 *
 * Untested upstream — `pyk/kore/tools.py` has no unit test and its integration
 * coverage goes through `KRun.run`.  The table here is new and exists to pin
 * the emission order, in the same shape as the other two in this directory.
 *
 * The `--output_file` row is the one worth reading twice: pyk's spelling is a
 * typo that the `kore-print` shell script's option table does not have, so it
 * falls into the script's `-*` catch-all and exits 1.  Nothing upstream or
 * downstream passes `output_file`, which is why the typo has survived.
 *
 * # The positional argument is a temp file, not `/dev/stdin`
 *
 * pyk passes `/dev/stdin` and pushes the pattern down the pipe; a child spawned
 * by Node or Bun cannot open that path (`src/stdio.ts` has the evidence), so
 * `korePrint` writes a temp file and passes *its* path.  The assertions below
 * therefore check the positional by **reading it while the child is
 * notionally running** — which is a stronger statement than the old
 * `toEqual('/dev/stdin')` was: it proves the bytes are actually there.
 */

import { describe, expect, test } from "bun:test";
import { app, koreText, sortApp } from "@kframework-ts/kore";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { caughtAsync } from "./caught.ts";
import { korePrint, korePrintArgs, PRINT_OUTPUTS, type KorePrintArgs, type ProcessRunner } from "../src/kore-print.ts";

//////////////////////////////
// The table                //
//////////////////////////////

interface Row {
  readonly id: string;
  readonly apply: (args: KorePrintArgs) => KorePrintArgs;
  readonly expected: readonly string[];
}

/** One row per `if` in `_kore_print` (`kore/tools.py:60-75`), in that order. */
const ROWS: readonly Row[] = [
  { id: "definitionDir", apply: (a) => ({ ...a, definitionDir: "def/path" }), expected: ["--definition", "def/path"] },
  { id: "outputFile", apply: (a) => ({ ...a, outputFile: "out/path" }), expected: ["--output-file", "out/path"] },
  { id: "output", apply: (a) => ({ ...a, output: "json" }), expected: ["--output", "json"] },
  { id: "color", apply: (a) => ({ ...a, color: true }), expected: ["--color", "on"] },
];

describe("korePrintArgs — the golden table (untested upstream)", () => {
  test("nothing but the command and the positional file", () => {
    expect(korePrintArgs("/dev/stdin")).toEqual(["kore-print", "/dev/stdin"]);
  });

  test("every flag at once, in emission order", () => {
    const args = ROWS.reduce<KorePrintArgs>((acc, row) => row.apply(acc), {});
    expect(korePrintArgs("/dev/stdin", args)).toEqual([
      "kore-print",
      "/dev/stdin",
      ...ROWS.flatMap((row) => row.expected),
    ]);
  });

  for (const row of ROWS) {
    test(`${row.id}: alone`, () => {
      expect(korePrintArgs("in.kore", row.apply({}))).toEqual(["kore-print", "in.kore", ...row.expected]);
    });
  }

  test("--output-file, hyphenated — pyk writes --output_file, which the script rejects", () => {
    const argv = korePrintArgs("in.kore", { outputFile: "out.txt" });
    expect(argv).toContain("--output-file");
    expect(argv).not.toContain("--output_file");
  });

  test("color: false is --color off, and absent is neither", () => {
    expect(korePrintArgs("in.kore", { color: false })).toEqual(["kore-print", "in.kore", "--color", "off"]);
    expect(korePrintArgs("in.kore", {})).toEqual(["kore-print", "in.kore"]);
  });

  test("PrintOutput carries upstream's eight members (`tools.py:14-22`)", () => {
    expect(PRINT_OUTPUTS).toEqual(["pretty", "program", "kast", "binary", "json", "latex", "kore", "none"]);
  });

  test("the command is a whole prefix", () => {
    expect(korePrintArgs("in.kore", { command: ["nix", "run", "kore-print"] })).toEqual([
      "nix",
      "run",
      "kore-print",
      "in.kore",
    ]);
  });
});

//////////////////////////////
// The function             //
//////////////////////////////

const PATTERN = app("Lbl'-LT-'k'-GT-'", [], [app("dotk", [sortApp("SortK")], [])]);

/**
 * A {@link ProcessRunner} that records every call and answers with `stdout`.
 *
 * `input` is what the *positional file* held at call time — the temp file
 * `korePrint` created — not `options.input`, which is now always absent.
 */
function recorder(calls: { args: readonly string[]; input: string | undefined }[], stdout = ""): ProcessRunner {
  return async (args, _options) => {
    const file = args[1];
    calls.push({ args: [...args], input: file === undefined ? undefined : readFileSync(file, "utf8") });
    return { args, returncode: 0, stdout, stderr: "", signal: undefined };
  };
}

/** The argv with the temp-file positional replaced by a stable placeholder. */
function withoutTempFile(args: readonly string[] | undefined): readonly string[] {
  return (args ?? []).map((arg, index) => (index === 1 ? "<temp>" : arg));
}

describe("korePrint — `kore_print` (`kore/tools.py:25-45`)", () => {
  test("output kore never forks: the input comes straight back", async () => {
    const calls: { args: readonly string[]; input: string | undefined }[] = [];
    const runner = recorder(calls, "SHOULD NOT BE USED");

    expect(await korePrint(PATTERN, { output: "kore", runner })).toBe(koreText(PATTERN));
    expect(await korePrint("some kore text", { output: "kore", runner })).toBe("some kore text");
    expect(calls).toEqual([]);
  });

  test("a Pattern is rendered with koreText into the file the child is given", async () => {
    const calls: { args: readonly string[]; input: string | undefined }[] = [];
    await korePrint(PATTERN, { output: "pretty", runner: recorder(calls, "<k> .K </k>\n") });

    expect(withoutTempFile(calls[0]?.args)).toEqual(["kore-print", "<temp>", "--output", "pretty"]);
    expect(calls[0]?.input).toBe(koreText(PATTERN));
  });

  test("the temp file is deleted once the call returns", async () => {
    const calls: { args: readonly string[]; input: string | undefined }[] = [];
    await korePrint(PATTERN, { output: "pretty", runner: recorder(calls, "x") });
    const file = calls[0]?.args[1] ?? "";
    expect(file).not.toBe("");
    expect(existsSync(file)).toBe(false);
  });

  test("the result is trimmed (`tools.py:78`)", async () => {
    const result = await korePrint(PATTERN, { output: "pretty", runner: recorder([], "  <k> .K </k>\n\n") });
    expect(result).toBe("<k> .K </k>");
  });

  test("a definition directory is checked, and then emitted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ktool-kore-print-"));
    try {
      const calls: { args: readonly string[]; input: string | undefined }[] = [];
      await korePrint(PATTERN, { definitionDir: dir, output: "json", runner: recorder(calls, "{}") });
      expect(withoutTempFile(calls[0]?.args)).toEqual([
        "kore-print",
        "<temp>",
        "--definition",
        dir,
        "--output",
        "json",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a missing definition directory is reported before the spawn", async () => {
    const error = await caughtAsync(
      korePrint(PATTERN, { definitionDir: join(tmpdir(), "ktool-absent-dir"), runner: recorder([]) }),
      Error,
    );
    expect(error.message).toMatch(/Directory does not exist/u);
  });

  test("an output file is *not* required to exist, unlike pyk's check_file_path", async () => {
    const calls: { args: readonly string[]; input: string | undefined }[] = [];
    const target = join(tmpdir(), "ktool-never-created.txt");
    await korePrint(PATTERN, { outputFile: target, runner: recorder(calls) });
    expect(withoutTempFile(calls[0]?.args)).toEqual(["kore-print", "<temp>", "--output-file", target]);
  });
});
