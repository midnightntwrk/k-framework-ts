/**
 * `src/kparse.ts` — the lookup rule, the dispatcher's argv, and the two
 * short-circuits, with **no K installed**.
 *
 * The rule under test is `k-distribution/src/main/scripts/bin/kparse:164-207`,
 * not a pyk function: pyk never looks for a generated parser. So the goldens
 * here are read off the script, and the fixture that grounds them is
 * `packages/kompiled/fixtures/generated/imp-llvm-kompiled/` — a real `kompile`
 * output whose `mainSyntaxModule.txt` is `IMP-SYNTAX` and whose `configVars.sh`
 * declares `declaredConfigVar_PGM='Pgm'`, so the defaults this file asserts are
 * the defaults a real directory produces.
 *
 * That fixture was built **without** `--gen-glr-bison-parser`, which is the
 * useful half: it pins the *negative* — `findBisonParser` returns `undefined`
 * and the dispatcher falls back to `kast` — while the live suite
 * (`test/live-throughput.test.ts`) pins the positive against a directory that
 * really does carry a `parser_<Sort>_<Module>`.
 *
 * # The positional argument for a `text` parse is a temp file
 *
 * The script writes `/dev/stdin` there; a child spawned by Node or Bun cannot
 * open that path (`src/stdio.ts`), so `kparse` materialises the text and passes
 * the file. The recorder below reads the positional back, which asserts more
 * than the path ever could: that the bytes are really there when the child
 * runs.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadKompiledLayout, parseKompiledLayout, type KompiledLayout } from "@kframework-ts/kompiled";

import { caughtAsync } from "./caught.ts";
import type { CompletedProcess } from "../src/proc.ts";
import {
  bisonParserName,
  bisonParserPath,
  DEFAULT_PARSE_SORT,
  findBisonParser,
  kparse,
  resolveKparseTarget,
} from "../src/kparse.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const IMP_LLVM = join(HERE, "..", "..", "kompiled", "fixtures", "generated", "imp-llvm-kompiled");

/** A layout with only the two fields the lookup rule reads. */
function layoutOf(mainSyntaxModule: string, pgmSort?: string): KompiledLayout {
  return parseKompiledLayout({
    mainModule: "M",
    mainSyntaxModule,
    backend: "llvm",
    timestampMtimeMs: 0,
    ...(pgmSort === undefined
      ? {}
      : { configVarsSh: `declaredConfigVar_PGM='${pgmSort}'\ndeclaredConfigVars=(\n    'PGM'\n)\n` }),
  });
}

/**
 * A recording {@link import('../src/kore-print.ts').ProcessRunner}.
 *
 * `calls` holds each argv with the positional replaced by `<in>` when it is one
 * of `kparse`'s own temp files, so the goldens are stable; `contents` holds what
 * that file actually held at call time.
 */
function recorder(stdout = "Lbl'Unds'{}()\n"): {
  readonly calls: (readonly string[])[];
  readonly run: (args: readonly string[], options: { input?: string }) => Promise<CompletedProcess>;
  readonly contents: (string | undefined)[];
  readonly stdin: (string | undefined)[];
} {
  const calls: (readonly string[])[] = [];
  const contents: (string | undefined)[] = [];
  const stdin: (string | undefined)[] = [];
  // Both routes put the input path at index 1: `kast <file> …` and
  // `parser_<Sort>_<Module> <file> [<location>]`.
  return {
    calls,
    contents,
    stdin,
    run: (args, options) => {
      const index = 1;
      const file = args[index] ?? "";
      const temp = /kparse-.*\.pgm$/u.test(file);
      contents.push(temp ? readFileSync(file, "utf8") : undefined);
      calls.push(args.map((arg, n) => (n === index && temp ? "<in>" : arg)));
      stdin.push(options.input);
      return Promise.resolve({ args, returncode: 0, stdout, stderr: "", signal: undefined });
    },
  };
}

//////////////////////////////
// Pure                     //
//////////////////////////////

describe("bisonParserName — `parser_<Sort>_<Module>` (`kparse:194`)", () => {
  test("joins with underscores and escapes nothing", () => {
    expect(bisonParserName("Exp", "TINY-SYNTAX")).toBe("parser_Exp_TINY-SYNTAX");
    expect(bisonParserName("Pgm", "IMP-SYNTAX")).toBe("parser_Pgm_IMP-SYNTAX");
    // Dotted module names are legal K and survive unchanged.
    expect(bisonParserName("KItem", "A.B-C")).toBe("parser_KItem_A.B-C");
  });

  test("bisonParserPath joins it onto the directory", () => {
    expect(bisonParserPath("/d", "Exp", "M")).toBe(join("/d", "parser_Exp_M"));
  });
});

describe("resolveKparseTarget — the two defaults (`kparse:179-190`)", () => {
  test("module defaults to mainSyntaxModule.txt", () => {
    expect(resolveKparseTarget(layoutOf("IMP-SYNTAX", "Pgm")).module).toBe("IMP-SYNTAX");
  });

  test("sort defaults to $PGM's declared sort", () => {
    expect(resolveKparseTarget(layoutOf("IMP-SYNTAX", "Pgm")).sort).toBe("Pgm");
  });

  test("sort falls back to KItem when the definition declares no $PGM (`:186`)", () => {
    expect(resolveKparseTarget(layoutOf("IMP-SYNTAX")).sort).toBe(DEFAULT_PARSE_SORT);
    expect(DEFAULT_PARSE_SORT).toBe("KItem");
  });

  test("an explicit query wins over both", () => {
    expect(resolveKparseTarget(layoutOf("IMP-SYNTAX", "Pgm"), { sort: "AExp", module: "OTHER" })).toEqual({
      sort: "AExp",
      module: "OTHER",
    });
  });

  test("the defaults a real kompiled directory produces", async () => {
    const layout = await loadKompiledLayout(IMP_LLVM);
    expect(resolveKparseTarget(layout)).toEqual({ sort: "Pgm", module: "IMP-SYNTAX" });
  });
});

//////////////////////////////
// Lookup                   //
//////////////////////////////

describe("findBisonParser — `kparse:164-167,194-195`", () => {
  test("a directory kompiled without --gen-bison-parser has none", async () => {
    const layout = await loadKompiledLayout(IMP_LLVM);
    expect(await findBisonParser(IMP_LLVM, layout)).toBeUndefined();
  });

  test("no syntaxDefinition.kore means no lookup at all (`:164-167`)", async () => {
    const dir = await scratch();
    // The parser is present and executable, but the syntax definition is not,
    // so the script bails to `kast` before it computes a sort.
    await executable(join(dir, "parser_Exp_M"));
    expect(await findBisonParser(dir, layoutOf("M", "Exp"))).toBeUndefined();
  });

  test("an executable parser_<Sort>_<Module> is found, and reports its target", async () => {
    const dir = await scratch();
    await writeFile(join(dir, "syntaxDefinition.kore"), "[]\nmodule M endmodule []\n");
    await executable(join(dir, "parser_Exp_M"));
    expect(await findBisonParser(dir, layoutOf("M", "Exp"))).toEqual({
      sort: "Exp",
      module: "M",
      path: join(dir, "parser_Exp_M"),
    });
  });

  test("a non-executable file of the right name is not a parser (`[ -x ]`, `:195`)", async () => {
    const dir = await scratch();
    await writeFile(join(dir, "syntaxDefinition.kore"), "[]\n");
    await writeFile(join(dir, "parser_Exp_M"), "not a binary");
    await chmod(join(dir, "parser_Exp_M"), 0o644);
    expect(await findBisonParser(dir, layoutOf("M", "Exp"))).toBeUndefined();
  });

  test("the query is what is looked up, not the defaults", async () => {
    const dir = await scratch();
    await writeFile(join(dir, "syntaxDefinition.kore"), "[]\n");
    await executable(join(dir, "parser_AExp_M"));
    expect(await findBisonParser(dir, layoutOf("M", "Exp"))).toBeUndefined();
    expect((await findBisonParser(dir, layoutOf("M", "Exp"), { sort: "AExp" }))?.sort).toBe("AExp");
  });
});

//////////////////////////////
// The dispatcher           //
//////////////////////////////

describe("kparse — the dispatcher (`kparse:192-208`)", () => {
  test("`--input kore` is answered in process, with no child (`:202-203`)", async () => {
    const runner = recorder();
    const result = await kparse({
      definitionDir: IMP_LLVM,
      input: "kore",
      text: "  Lbl'Unds'{}()  \n",
      runner: runner.run,
    });
    expect(result.kore).toBe("Lbl'Unds'{}()");
    expect(result.parser).toBeUndefined();
    expect(runner.calls).toEqual([]);
  });

  test("`--input kore` with a file cats it, still with no child (`:202-203`)", async () => {
    const dir = await scratch();
    const file = join(dir, "term.kore");
    await writeFile(file, "  Lbl'Unds'{}()  \n");
    const runner = recorder();
    const result = await kparse({ definitionDir: IMP_LLVM, input: "kore", file, runner: runner.run });
    expect(result.kore).toBe("Lbl'Unds'{}()");
    expect(runner.calls).toEqual([]);
  });

  test("with no native parser it runs `kast --output kore` (`:198`)", async () => {
    const runner = recorder();
    const result = await kparse({
      definitionDir: IMP_LLVM,
      text: "int x;",
      sort: "Pgm",
      layout: await loadKompiledLayout(IMP_LLVM),
      runner: runner.run,
    });
    expect(result.parser).toBeUndefined();
    expect(runner.calls).toEqual([
      ["kast", "<in>", "--definition", IMP_LLVM, "--input", "program", "--output", "kore", "--sort", "Pgm"],
    ]);
    expect(runner.contents).toEqual(["int x;"]);
    // The text is in the file, not on the pipe: `/dev/stdin` is unopenable.
    expect(runner.stdin).toEqual([undefined]);
  });

  test("a resolved parser is exec'd as `parser <file>`, and reported (`:196`)", async () => {
    const dir = await scratch();
    await writeFile(join(dir, "syntaxDefinition.kore"), "[]\n");
    await executable(join(dir, "parser_Exp_M"));
    const runner = recorder("Lbl'Plus'{}()\n");

    const result = await kparse({
      definitionDir: dir,
      layout: layoutOf("M", "Exp"),
      text: "1 + 2",
      runner: runner.run,
    });

    expect(result.parser?.path).toBe(join(dir, "parser_Exp_M"));
    // argv[2] defaults to `/dev/stdin` for a `text` parse so that the
    // `Source(…)` attributes are stable rather than naming a random temp path.
    expect(runner.calls).toEqual([[join(dir, "parser_Exp_M"), "<in>", "/dev/stdin"]]);
    expect(runner.contents).toEqual(["1 + 2"]);
    // Trimmed, so the native route and the `kast` route return the same string.
    expect(result.kore).toBe("Lbl'Plus'{}()");
  });

  test("a file is passed positionally rather than on stdin", async () => {
    const dir = await scratch();
    await writeFile(join(dir, "syntaxDefinition.kore"), "[]\n");
    await executable(join(dir, "parser_Exp_M"));
    const program = join(dir, "p.exp");
    await writeFile(program, "1 + 2");
    const runner = recorder();

    await kparse({ definitionDir: dir, layout: layoutOf("M", "Exp"), file: program, runner: runner.run });
    // A real file keeps upstream's shape exactly: no argv[2], no temp file.
    expect(runner.calls).toEqual([[join(dir, "parser_Exp_M"), program]]);
    expect(runner.stdin).toEqual([undefined]);
  });

  test("locationFile becomes argv[2] (`cparser/main.c:310-316`)", async () => {
    const dir = await scratch();
    await writeFile(join(dir, "syntaxDefinition.kore"), "[]\n");
    await executable(join(dir, "parser_Exp_M"));
    const runner = recorder();

    await kparse({
      definitionDir: dir,
      layout: layoutOf("M", "Exp"),
      text: "1",
      locationFile: "prog.exp",
      runner: runner.run,
    });
    expect(runner.calls).toEqual([[join(dir, "parser_Exp_M"), "<in>", "prog.exp"]]);
  });

  test("`native: false` refuses the parser and takes the JVM route", async () => {
    const dir = await scratch();
    await writeFile(join(dir, "syntaxDefinition.kore"), "[]\n");
    await executable(join(dir, "parser_Exp_M"));
    const runner = recorder();

    const result = await kparse({
      definitionDir: dir,
      layout: layoutOf("M", "Exp"),
      text: "1",
      native: false,
      runner: runner.run,
    });
    expect(result.parser).toBeUndefined();
    expect(runner.calls[0]?.[0]).toBe("kast");
  });

  test("only `--input program` gets the fast path (`:192-200`)", async () => {
    const dir = await scratch();
    await writeFile(join(dir, "syntaxDefinition.kore"), "[]\n");
    await executable(join(dir, "parser_Exp_M"));
    const runner = recorder();

    const result = await kparse({
      definitionDir: dir,
      layout: layoutOf("M", "Exp"),
      input: "json",
      text: "{}",
      runner: runner.run,
    });
    expect(result.parser).toBeUndefined();
    expect(runner.calls[0]).toEqual(["kast", "<in>", "--definition", dir, "--input", "json", "--output", "kore"]);
  });

  test("the temp file is deleted once the call returns", async () => {
    const runner = recorder();
    let observed = "";
    await kparse({
      definitionDir: IMP_LLVM,
      text: "int x;",
      layout: await loadKompiledLayout(IMP_LLVM),
      runner: (args, options) => {
        observed = args[1] ?? "";
        return runner.run(args, options);
      },
    });
    expect(observed).toMatch(/kparse-.*\.pgm$/u);
    expect(existsSync(observed)).toBe(false);
  });

  test("exactly one of `file` and `text` is required", async () => {
    const both = await caughtAsync(kparse({ definitionDir: IMP_LLVM, file: "x", text: "y" }), Error);
    expect(both.message).toBe("kparse needs exactly one of `file` and `text`");
    const neither = await caughtAsync(kparse({ definitionDir: IMP_LLVM }), Error);
    expect(neither.message).toBe("kparse needs exactly one of `file` and `text`");
  });

  test("a directory that is not one is reported before any spawn", async () => {
    const runner = recorder();
    const error = await caughtAsync(
      kparse({ definitionDir: join(IMP_LLVM, "nope"), text: "x", runner: runner.run }),
      Error,
    );
    expect(error.message).toStartWith("Directory does not exist:");
    expect(runner.calls).toEqual([]);
  });
});

//////////////////////////////
// Scratch                  //
//////////////////////////////

const scratchDirs: string[] = [];

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ktool-kparse-"));
  scratchDirs.push(dir);
  return dir;
}

/** A file with the executable bit set — the only property `[ -x ]` tests. */
async function executable(path: string): Promise<void> {
  await writeFile(path, "#!/bin/sh\nexit 0\n");
  await chmod(path, 0o755);
}

afterAll(async () => {
  await Promise.all(scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
