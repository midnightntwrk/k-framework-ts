/**
 * The `krun` argv golden table, its two preconditions, and `KRun`'s four entry
 * points driven through an injected runner.
 *
 * # The table is upstream's, verbatim
 *
 * `pyk/src/tests/unit/ktool/test_krun.py` is the **only** unit test in all of
 * pyk's `ktool`, and it is exactly this: a dictionary of seventeen keys, one
 * case per key alone, one case with every key at once, and one with none.  The
 * values below — `input/path`, `def/path`, `1234`, `{'FOO': 'bar', 'BUZZ':
 * 'kill'}` — are upstream's values, not new ones, so a diff against
 * `optional_args` (`test_krun.py:32-49`) reads as a rename table and nothing
 * else.
 *
 * Three mechanical differences, none of them behavioural:
 *
 * - keys are camelCase (`input_file` → `inputFile`), this package's spelling;
 * - `command` is `readonly string[]` and defaults to `['krun']`, where pyk
 *   takes a bare `str` — the same convention `kompile.ts` already uses, and it
 *   produces the same first element;
 * - the rows are `apply` functions rather than a `Record<string, unknown>`, so
 *   the table type-checks against {@link KrunArgs} instead of being cast into
 *   it.  A misspelled key is a compile error here and a silently ignored kwarg
 *   upstream.
 *
 * # Everything else is new
 *
 * pyk has no unit coverage of `_krun`'s validation, of `KRun` at all, or of the
 * `--output kore --parser cat` invariant.  The `KRun` cases below inject a
 * {@link ProcessRunner} that records its argv and returns canned KORE, so the
 * whole class is exercised with no `krun` binary anywhere.
 */

import { describe, expect, test } from "bun:test";
import { fromDict, kastTerm, kastTermToDict, ksort } from "@kframework-ts/kast";
import { koreText, type Pattern } from "@kframework-ts/kore";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { caughtAsync } from "./caught.ts";
import type { ProcessRunner } from "../src/kore-print.ts";
import { KPrint } from "../src/kprint.ts";
import { KRun, KRunArgumentError, KRUN_OUTPUTS, krunArgs, runKrun, type KrunArgs } from "../src/krun.ts";
import type { CompletedProcess } from "../src/proc.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const GENERATED = join(HERE, "..", "..", "kompiled", "fixtures", "generated");
const IMP_LLVM = join(GENERATED, "imp-llvm-kompiled");

//////////////////////////////
// The upstream table       //
//////////////////////////////

interface Row {
  /** The key's name, which is also the test id — `test_data` (`test_krun.py:62-66`). */
  readonly id: string;
  readonly apply: (args: KrunArgs) => KrunArgs;
  readonly expected: readonly string[];
}

/** `optional_args` (`test_krun.py:32-49`), key for key and value for value. */
const ROWS: readonly Row[] = [
  { id: "inputFile", apply: (a) => ({ ...a, inputFile: "input/path" }), expected: ["input/path"] },
  { id: "definitionDir", apply: (a) => ({ ...a, definitionDir: "def/path" }), expected: ["--definition", "def/path"] },
  { id: "output", apply: (a) => ({ ...a, output: "json" }), expected: ["--output", "json"] },
  { id: "parser", apply: (a) => ({ ...a, parser: "cat" }), expected: ["--parser", "cat"] },
  { id: "depth", apply: (a) => ({ ...a, depth: 1234 }), expected: ["--depth", "1234"] },
  {
    id: "pmap",
    apply: (a) => ({ ...a, pmap: { FOO: "bar", BUZZ: "kill" } }),
    expected: ["-pFOO=bar", "-pBUZZ=kill"],
  },
  {
    id: "cmap",
    apply: (a) => ({ ...a, cmap: { COO: "car", FUZZ: "bill" } }),
    expected: ["-cCOO=car", "-cFUZZ=bill"],
  },
  { id: "term", apply: (a) => ({ ...a, term: true }), expected: ["--term"] },
  { id: "tempDir", apply: (a) => ({ ...a, tempDir: "/tmp/path" }), expected: ["--temp-dir", "/tmp/path"] },
  { id: "saveTemps", apply: (a) => ({ ...a, saveTemps: true }), expected: ["--save-temps"] },
  { id: "statistics", apply: (a) => ({ ...a, statistics: true }), expected: ["--statistics"] },
  { id: "noExpandMacros", apply: (a) => ({ ...a, noExpandMacros: true }), expected: ["--no-expand-macros"] },
  { id: "searchFinal", apply: (a) => ({ ...a, searchFinal: true }), expected: ["--search-final"] },
  { id: "search", apply: (a) => ({ ...a, search: true }), expected: ["--search"] },
  { id: "noPattern", apply: (a) => ({ ...a, noPattern: true }), expected: ["--no-pattern"] },
  { id: "debugger", apply: (a) => ({ ...a, debugger: true }), expected: ["--debugger"] },
  { id: "proofHint", apply: (a) => ({ ...a, proofHint: true }), expected: ["--proof-hint"] },
];

describe("krunArgs — the ported test_krun.py table", () => {
  test("optional-only: nothing but the command", () => {
    expect(krunArgs()).toEqual(["krun"]);
    expect(krunArgs({})).toEqual(["krun"]);
  });

  test("all-args: every key at once, in emission order", () => {
    // Note that this row sets `term` **and** `pmap`/`cmap`, which `runKrun`
    // rejects.  Upstream's does too: `_build_arg_list` is the builder and
    // `_krun` is the validator, and the table tests the builder.
    const args = ROWS.reduce<KrunArgs>((acc, row) => row.apply(acc), {});
    expect(krunArgs(args)).toEqual(["krun", ...ROWS.flatMap((row) => row.expected)]);
  });

  for (const row of ROWS) {
    test(`${row.id}: alone`, () => {
      expect(krunArgs(row.apply({}))).toEqual(["krun", ...row.expected]);
    });
  }
});

describe("krunArgs — the orderings and defaults the table cannot show", () => {
  test("KRunOutput carries upstream's eight members (`krun.py:34-42`)", () => {
    expect(KRUN_OUTPUTS).toEqual(["pretty", "program", "kast", "binary", "json", "latex", "kore", "none"]);
  });

  test("--depth 0 is emitted: `depth is not None` (`:400`), not `if depth`", () => {
    expect(krunArgs({ depth: 0 })).toEqual(["krun", "--depth", "0"]);
  });

  test("pmap comes before cmap however they were passed (`:402-405`)", () => {
    expect(krunArgs({ cmap: { A: "1" }, pmap: { B: "2" } })).toEqual(["krun", "-pB=2", "-cA=1"]);
  });

  test("a config-var pair is one unescaped argv element, spaces and all", () => {
    expect(krunArgs({ cmap: { PGM: "a b" } })).toEqual(["krun", "-cPGM=a b"]);
  });

  test("a Map preserves its own insertion order", () => {
    const pmap = new Map([
      ["Z", "1"],
      ["A", "2"],
    ]);
    expect(krunArgs({ pmap })).toEqual(["krun", "-pZ=1", "-pA=2"]);
  });

  test("the command is a whole prefix, not just an executable", () => {
    expect(krunArgs({ command: ["kevm", "run"], term: true })).toEqual(["kevm", "run", "--term"]);
  });

  test("an empty string is absent, as pyk's truthiness makes it", () => {
    expect(krunArgs({ inputFile: "", parser: "", tempDir: "", definitionDir: "" })).toEqual(["krun"]);
  });
});

//////////////////////////////
// Preconditions            //
//////////////////////////////

describe("runKrun's preconditions — `_krun` (`krun.py:328-338`)", () => {
  test("a negative depth is refused before anything is spawned", async () => {
    const error = await caughtAsync(runKrun({ depth: -1 }), KRunArgumentError);
    expect(error.message).toBe("Expected non-negative depth, got: -1");
  });

  test("depth 0 is not negative", async () => {
    // It gets past the depth check and dies on the missing binary instead,
    // which is the proof that the check let it through.
    const error = await caughtAsync(runKrun({ command: ["ktool-no-such-krun"], depth: 0 }), Error);
    expect(error).not.toBeInstanceOf(KRunArgumentError);
  });

  test("term with cmap is refused", async () => {
    const error = await caughtAsync(runKrun({ term: true, cmap: { A: "1" } }), KRunArgumentError);
    expect(error.message).toBe("Cannot supply both term and cmap/pmap");
  });

  test("term with pmap is refused too", async () => {
    await caughtAsync(runKrun({ term: true, pmap: { A: "1" } }), KRunArgumentError);
  });

  test("term alone is fine", async () => {
    const calls: (readonly string[])[] = [];
    await runKrun({ term: true, runner: recorder(calls) });
    expect(calls).toEqual([["krun", "--term"]]);
  });

  test("debugger inherits the streams and hands the status back, where pyk execvp's", async () => {
    // A real spawn, because the whole point of this path is that it does *not*
    // go through the injected runner: nothing is captured, so the runner has
    // nothing to hand over.  `bash -c 'exit 5' --debugger` takes `--debugger`
    // as `$0` and exits 5.
    const argv = { command: ["bash", "-c", "exit 5"], debugger: true } as const;

    const result = await runKrun({ ...argv, check: false });
    expect(result.returncode).toBe(5);
    expect(result.stdout).toBe("");
    expect(result.args).toEqual(["bash", "-c", "exit 5", "--debugger"]);

    const error = await caughtAsync(runKrun(argv), Error);
    expect(error.name).toBe("ProcessError");
  });

  test("a missing input file is reported before the spawn", async () => {
    const error = await caughtAsync(runKrun({ inputFile: join(tmpdir(), "ktool-absent.kore") }), Error);
    expect(error.message).toMatch(/File does not exist/u);
  });

  test("a missing definition directory is reported before the spawn", async () => {
    const error = await caughtAsync(runKrun({ definitionDir: join(tmpdir(), "ktool-absent-dir") }), Error);
    expect(error.message).toMatch(/Directory does not exist/u);
  });
});

//////////////////////////////
// The class                //
//////////////////////////////

/** A {@link ProcessRunner} that records every argv and answers with `stdout`. */
function recorder(calls: (readonly string[])[], stdout = "", returncode = 0): ProcessRunner {
  return async (args) => {
    calls.push([...args]);
    return { args, returncode, stdout, stderr: "", signal: undefined } satisfies CompletedProcess;
  };
}

const readTerm = (name: string) =>
  fromDict(kastTerm(JSON.parse(readFileSync(join(GENERATED, "imp-llvm-krun", name), "utf8"))));

/** The final configuration of `sum.imp`, as KORE — a real term, converted in-process. */
async function sumKore(): Promise<{ readonly pattern: Pattern; readonly text: string }> {
  const kprint = await KPrint.load(IMP_LLVM, { conversionStrategy: "pure" });
  const pattern = await kprint.kastToKore(readTerm("sum.imp.json"), { sort: ksort("GeneratedTopCell") });
  return { pattern, text: koreText(pattern) };
}

describe("KRun.runProcess — the three things it never lets you change", () => {
  test("always --output kore --parser cat, with the pattern in a temp file", async () => {
    const calls: (readonly string[])[] = [];
    const { pattern } = await sumKore();
    const krun = await KRun.load(IMP_LLVM, { runner: recorder(calls) });

    await krun.runProcess(pattern);

    const argv = calls[0] ?? [];
    expect(argv[0]).toBe("krun");
    // `[command, inputFile, --definition, dir, --output, kore, --parser, cat]`
    expect(argv[1]).toMatch(/krun-.*\.kore$/u);
    expect(argv.slice(2)).toEqual(["--definition", IMP_LLVM, "--output", "kore", "--parser", "cat"]);
  });

  test("expandMacros defaults to true here, so --no-expand-macros is absent (`krun.py:74`)", async () => {
    const calls: (readonly string[])[] = [];
    const { pattern } = await sumKore();
    const krun = await KRun.load(IMP_LLVM, { runner: recorder(calls) });

    await krun.runProcess(pattern);
    expect(calls[0]).not.toContain("--no-expand-macros");

    await krun.runProcess(pattern, { expandMacros: false });
    expect(calls[1]).toContain("--no-expand-macros");
  });

  test("the temp file is gone afterwards when no useDirectory was configured", async () => {
    const paths: string[] = [];
    const { pattern } = await sumKore();
    const krun = await KRun.load(IMP_LLVM, {
      runner: async (args) => {
        paths.push(args[1] ?? "");
        return { args, returncode: 0, stdout: "", stderr: "", signal: undefined };
      },
    });

    await krun.runProcess(pattern);
    expect(await Bun.file(paths[0] ?? "").exists()).toBe(false);
  });

  test("a configured useDirectory keeps the file and becomes --temp-dir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ktool-krun-"));
    try {
      const calls: (readonly string[])[] = [];
      const { pattern } = await sumKore();
      const krun = await KRun.load(IMP_LLVM, { useDirectory: dir, runner: recorder(calls) });

      await krun.runProcess(pattern);

      const argv = calls[0] ?? [];
      expect(argv).toContain("--temp-dir");
      expect(argv[argv.indexOf("--temp-dir") + 1]).toBe(dir);
      // `delete=not self.use_directory` (`kprint.py:212`) — the evidence stays.
      expect(await Bun.file(argv[1] ?? "").exists()).toBe(true);
      expect(await Bun.file(argv[1] ?? "").text()).toBe(koreText(pattern));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("KRun.run — the four rendering routes (`krun.py:248-258`)", () => {
  test("forwards call controls into a binary JSON conversion child", async () => {
    const { pattern, text } = await sumKore();
    const conversionCalls: { readonly timeoutMs: number | undefined; readonly killGraceMs: number | undefined }[] = [];
    const kprint = await KPrint.load(IMP_LLVM, {
      conversionStrategy: "binary",
      runner: async (args, options) => {
        conversionCalls.push({ timeoutMs: options.timeoutMs, killGraceMs: options.killGraceMs });
        return {
          args,
          returncode: 0,
          stdout: JSON.stringify(kastTermToDict(readTerm("sum.imp.json"))),
          stderr: "",
          signal: undefined,
        };
      },
    });
    const krun = new KRun(kprint, {
      runner: async (args) => ({ args, returncode: 0, stdout: text, stderr: "", signal: undefined }),
    });

    await krun.run(pattern, { output: "json", timeoutMs: 23, killGraceMs: 5 });

    expect(conversionCalls).toEqual([{ timeoutMs: 23, killGraceMs: 5 }]);
  });

  test("json renders in-process, as the KAST v4 envelope", async () => {
    const term = readTerm("sum.imp.json");
    const { pattern, text } = await sumKore();
    const krun = await KRun.load(IMP_LLVM, { conversionStrategy: "pure", runner: recorder([], text) });

    const rendered = await krun.run(pattern, { output: "json" });
    expect(JSON.parse(rendered ?? "")).toEqual(kastTermToDict(term));
  });

  test("kore renders in-process too — no second child", async () => {
    const calls: (readonly string[])[] = [];
    const { pattern, text } = await sumKore();
    const krun = await KRun.load(IMP_LLVM, { runner: recorder(calls, text) });

    expect(await krun.run(pattern, { output: "kore" })).toBe(text);
    expect(calls).toHaveLength(1);
  });

  test("pretty hands the KORE to kore-print", async () => {
    const calls: (readonly string[])[] = [];
    const { pattern, text } = await sumKore();
    const krun = await KRun.load(IMP_LLVM, {
      runner: async (args) => {
        calls.push([...args]);
        // `korePrint` now delivers the pattern as a *file* rather than on
        // stdin (`src/stdio.ts`), so the length is read from there.
        const stdout = args[0] === "kore-print" ? `pretty(${readFileSync(args[1] ?? "", "utf8").length})\n` : text;
        return { args, returncode: 0, stdout, stderr: "", signal: undefined };
      },
    });

    expect(await krun.run(pattern, { output: "pretty" })).toBe(`pretty(${text.length})`);
    const argv = calls[1] ?? [];
    expect([argv[0], argv[2], argv[3], argv[4], argv[5]]).toEqual([
      "kore-print",
      "--definition",
      IMP_LLVM,
      "--output",
      "pretty",
    ]);
    expect(argv[1]).toMatch(/kore-print-.*\.kore$/u);
  });

  test("none renders nothing and parses nothing", async () => {
    const calls: (readonly string[])[] = [];
    const krun = await KRun.load(IMP_LLVM, { runner: recorder(calls, "this is not KORE at all") });
    const { pattern } = await sumKore();

    expect(await krun.run(pattern, { output: "none" })).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  test("check throws on a non-zero status — after the rendering, as pyk does", async () => {
    const { pattern, text } = await sumKore();
    const krun = await KRun.load(IMP_LLVM, { runner: recorder([], text, 3) });

    // Without `check` the same run is a normal return, which is the point of
    // `run_process` passing `check=False` downwards.
    expect(await krun.run(pattern, { output: "kore" })).toBe(text);
    const error = await caughtAsync(krun.run(pattern, { output: "kore", check: true }), Error);
    expect(error.name).toBe("ProcessError");
  });
});

describe("KRun.runPattern — `run_pattern` (`krun.py:263-295`)", () => {
  test("forces --term and flips expandMacros to false (`:269`)", async () => {
    const calls: (readonly string[])[] = [];
    const { pattern, text } = await sumKore();
    const krun = await KRun.load(IMP_LLVM, { runner: recorder(calls, text) });

    const result = await krun.runPattern(pattern);

    expect(koreText(result)).toBe(text);
    expect(calls[0]).toContain("--term");
    expect(calls[0]).toContain("--no-expand-macros");
  });

  test("trailing garbage is an error, where pyk's assert would vanish under -O", async () => {
    const { pattern, text } = await sumKore();
    const krun = await KRun.load(IMP_LLVM, { runner: recorder([], `${text} leftover{}()`) });
    await caughtAsync(krun.runPattern(pattern), Error);
  });
});

describe("KRun.krun — the ledger's `self.command` row (`krun.py:297-301`)", () => {
  test("honours the configured command, which upstream ignores here", async () => {
    const calls: (readonly string[])[] = [];
    const { text } = await sumKore();
    const dir = await mkdtemp(join(tmpdir(), "ktool-krun-in-"));
    try {
      const inputFile = join(dir, "pgm.imp");
      await Bun.write(inputFile, "int x;");
      const krun = await KRun.load(IMP_LLVM, {
        krunCommand: ["kevm", "run"],
        conversionStrategy: "pure",
        runner: recorder(calls, text, 7),
      });

      const { returncode, kast } = await krun.krun(inputFile, { parser: "cat" });

      expect(calls[0]?.slice(0, 2)).toEqual(["kevm", "run"]);
      expect(returncode).toBe(7);
      expect(kast).toEqual(readTerm("sum.imp.json"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
