/**
 * The end-to-end scenarios of pyk's only `kfuzz` test
 * (`pyk/src/tests/integration/ktool/test_fuzz.py`), against a real
 * `kompile --backend llvm` output and the real `interpreter` binary.
 *
 * The three upstream cases are all here:
 *
 * - `test_fuzz` — a property that holds, fuzzed to completion;
 * - `test_fuzz_fail` — a **planted violation** that the fuzzer must find;
 * - `test_fuzz_with_subst` — the same, with a `substFunc` that only touches
 *   the `<k>` cell.
 *
 * …plus the mode upstream's test never exercises at all: `checkExitCode`.
 * Nothing in pyk's suite calls `fuzz_with_exit_code`, so the fixture semantics
 * carries an `exit=""` cell and both modes are driven over the same run.
 *
 * # How the template is built
 *
 * Upstream parses a program with `_kast --output kore` and then wraps it with
 * `top_cell_initializer`, a prelude function `@kframework-ts/kore` had not yet
 * ported when this test was written (its `topCellInitializer` exists now).  The
 * template comes from `krun --depth 0 --output kore` instead, and stays that
 * way: K itself assembles the whole initial configuration, which is strictly
 * more faithful than reconstructing one, and the two marker
 * integers in the program text are then swapped for `EVar`s the same way
 * `test_fuzz.py:99-107` swaps its two marker identifiers.
 *
 * `krun` is asked with `check: false` because the fixture's `exit=""` cell
 * starts at 1 — "nothing proved yet" — so a zero-step run legitimately exits
 * non-zero.  Its stdout is the KORE either way.
 */

import { describe, expect, test } from "bun:test";
import { bottomUp, evar, KoreParser, koreText, sortApp, type EVar, type Pattern } from "@kframework-ts/kore";
import { runKrun } from "@kframework-ts/ktool";
import { describeKompiled, requireKTestEnvironment } from "@kframework-ts/ktool/testing";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ExitCodeAssertionError, KFuzzError } from "../src/errors.ts";
import { KFuzz } from "../src/fuzz.ts";
import { kintegers } from "../src/strategies.ts";
import { substituteVars, type KoreSubst } from "../src/subst.ts";
import { caughtAsync, causeOf } from "./caught.ts";

const FIXTURE = join(import.meta.dir, "..", "fixtures", "live-k", "fuzz-test.k");

const INT = sortApp("SortInt");
const VAR_X: EVar = evar("VarX", INT);
const VAR_Y: EVar = evar("VarY", INT);

/** The two literals in a template program, swapped for variables after parsing. */
const MARKER_X = "1234567";
const MARKER_Y = "7654321";

/** 0..20 is small enough that `ordered(X, Y)` is violated within a handful of draws. */
const STRATEGY: readonly (readonly [EVar, ReturnType<typeof kintegers>])[] = [
  [VAR_X, kintegers({ minValue: 0, maxValue: 20 })],
  [VAR_Y, kintegers({ minValue: 0, maxValue: 20 })],
];

/**
 * `krun --depth 0 --output kore` over `programText`, with the marker integers
 * replaced by `VarX` and `VarY`.
 *
 * This is `setup_program` (`test_fuzz.py:93-114`) with `krun` doing the
 * top-cell assembly that upstream does with `top_cell_initializer`.
 */
async function templateFor(definitionDir: string, programText: string): Promise<Pattern> {
  const environment = await requireKTestEnvironment();
  const scratch = await mkdtemp(join(tmpdir(), "kfuzz-live-"));
  const programFile = join(scratch, "program.pgm");
  await writeFile(programFile, programText, "utf8");

  const result = await runKrun({
    command: [join(environment.binDir, "krun")],
    definitionDir,
    inputFile: programFile,
    depth: 0,
    output: "kore",
    // The `exit=""` cell starts at 1, so a zero-step run exits non-zero by
    // construction. stdout carries the configuration regardless.
    check: false,
  });
  expect(result.stdout).toContain("Lbl'-LT-'generatedTop'-GT-'");

  return bottomUp(new KoreParser(result.stdout).pattern(), (node) => {
    if (node.tag !== "DV" || koreText(node.sort) !== koreText(INT)) return node;
    if (node.value.value === MARKER_X) return VAR_X;
    if (node.value.value === MARKER_Y) return VAR_Y;
    return node;
  });
}

/** The `<res>` cell's integer, read out of an output configuration. */
function resultCell(pattern: Pattern): bigint {
  let found: bigint | undefined;
  bottomUp(pattern, (node) => {
    if (node.tag === "App" && node.symbol === "Lbl'-LT-'res'-GT-'") {
      const [value] = node.args;
      if (value?.tag === "DV") found = BigInt(value.value.value);
    }
    return node;
  });
  if (found === undefined) throw new Error(`no <res> cell in ${koreText(pattern)}`);
  return found;
}

/** pyk's `check`: walk the output and assert the verdict cell is 0 (`test_fuzz.py:77-91`). */
function checkPassed(pattern: Pattern): void {
  const verdict = resultCell(pattern);
  if (verdict !== 0n) throw new Error(`<res> is ${verdict}, expected 0`);
}

/** The integer a counterexample bound to `variable`. */
function bound(subst: KoreSubst, variable: EVar): bigint {
  const value = subst.get(variable);
  if (value?.tag !== "DV") throw new Error(`no domain value for ${variable.name}`);
  return BigInt(value.value.value);
}

describeKompiled(
  describe,
  "kfuzz against a live LLVM interpreter",
  {
    backend: "llvm",
    mainFile: FIXTURE,
    mainModule: "FUZZ-TEST",
    syntaxModule: "FUZZ-TEST-SYNTAX",
  },
  (definitionDir) => {
    //////////////////////////////
    // The property that holds  //
    //////////////////////////////

    test("a property that holds survives every case — `test_fuzz`", async () => {
      const dir = await definitionDir;
      const template = await templateFor(dir, `commutes(${MARKER_X}, ${MARKER_Y})`);
      const kfuzz = new KFuzz(dir);
      const report = await kfuzz.fuzzWithCheck(template, STRATEGY, checkPassed, { seed: 20250806, numRuns: 25 });
      expect(report.numRuns).toBe(25);
      expect(report.seed).toBe(20250806);
    }, 120_000);

    test("…and passes in exit-code mode too, which upstream never tests", async () => {
      const dir = await definitionDir;
      const template = await templateFor(dir, `commutes(${MARKER_X}, ${MARKER_Y})`);
      const report = await new KFuzz(dir).fuzzWithExitCode(template, STRATEGY, { seed: 20250806, numRuns: 25 });
      expect(report.numRuns).toBe(25);
    }, 120_000);

    //////////////////////////////
    // The planted violation    //
    //////////////////////////////

    test("the planted violation is found, and the counterexample really violates it — `test_fuzz_fail`", async () => {
      const dir = await definitionDir;
      // `ordered(X, Y)` claims X <= Y for unconstrained X and Y. It is false.
      const template = await templateFor(dir, `ordered(${MARKER_X}, ${MARKER_Y})`);
      const failure = await caughtAsync(
        new KFuzz(dir).fuzzWithCheck(template, STRATEGY, checkPassed, { seed: 20250806, numRuns: 100 }),
        KFuzzError,
      );

      const x = bound(failure.counterexample!, VAR_X);
      const y = bound(failure.counterexample!, VAR_Y);
      // The property was `x <= y`; a genuine counterexample has x > y.
      expect(x > y).toBe(true);
      expect(causeOf(failure, Error).message).toBe("<res> is 1, expected 0");
      // Everything a replay needs is a field, not a substring.
      expect(failure.seed).toBe(20250806);
      expect(failure.path).toBeString();
      expect(failure.numShrinks).toBe(0);
    }, 120_000);

    test("the same violation is found through the exit code alone", async () => {
      const dir = await definitionDir;
      const template = await templateFor(dir, `ordered(${MARKER_X}, ${MARKER_Y})`);
      const failure = await caughtAsync(
        new KFuzz(dir).fuzzWithExitCode(template, STRATEGY, { seed: 20250806, numRuns: 100 }),
        KFuzzError,
      );
      // The `exit=""` cell holds 1 on a violation, and the LLVM backend turns
      // that cell into the process's status (`finish_rewriting.cpp`).
      expect(causeOf(failure, ExitCodeAssertionError).returncode).toBe(1);
    }, 120_000);

    test("the counterexample replays to the same failure, from seed and path", async () => {
      const dir = await definitionDir;
      const template = await templateFor(dir, `ordered(${MARKER_X}, ${MARKER_Y})`);
      const kfuzz = new KFuzz(dir);
      const first = await caughtAsync(
        kfuzz.fuzzWithCheck(template, STRATEGY, checkPassed, { seed: 20250806, numRuns: 100 }),
        KFuzzError,
      );
      const replay = await caughtAsync(
        kfuzz.fuzzWithCheck(template, STRATEGY, checkPassed, {
          seed: first.seed,
          path: first.path!,
          numRuns: 100,
        }),
        KFuzzError,
      );
      expect(replay.numRuns).toBe(1);
      expect(bound(replay.counterexample!, VAR_X)).toBe(bound(first.counterexample!, VAR_X));
      expect(bound(replay.counterexample!, VAR_Y)).toBe(bound(first.counterexample!, VAR_Y));
    }, 120_000);

    test("with shrinking on, the counterexample is minimal", async () => {
      const dir = await definitionDir;
      const template = await templateFor(dir, `ordered(${MARKER_X}, ${MARKER_Y})`);
      const failure = await caughtAsync(
        new KFuzz(dir).fuzzWithCheck(template, STRATEGY, checkPassed, {
          seed: 20250806,
          numRuns: 100,
          shrink: true,
        }),
        KFuzzError,
      );
      expect(failure.numShrinks).toBeGreaterThan(0);
      // The smallest pair in 0..20 with x > y.
      expect(bound(failure.counterexample!, VAR_X)).toBe(1n);
      expect(bound(failure.counterexample!, VAR_Y)).toBe(0n);
    }, 180_000);

    //////////////////////////////
    // The custom substFunc     //
    //////////////////////////////

    test("a substFunc restricted to the <k> cell reaches the same verdicts — `test_fuzz_with_subst`", async () => {
      const dir = await definitionDir;
      const template = await templateFor(dir, `commutes(${MARKER_X}, ${MARKER_Y})`);

      // Upstream's optimisation: descend only the cell that holds variables,
      // rebuilding the rest of the configuration untouched.
      let restricted = 0;
      const substFunc = (pattern: Pattern, subst: KoreSubst): Pattern => {
        restricted += 1;
        return bottomUp(pattern, (node) =>
          node.tag === "App" && node.symbol === "Lbl'-LT-'k'-GT-'" ? substituteVars(node, subst) : node,
        );
      };

      const report = await new KFuzz(dir, { substFunc }).fuzzWithCheck(template, STRATEGY, checkPassed, {
        seed: 20250806,
        numRuns: 10,
      });
      expect(report.numRuns).toBe(10);
      expect(restricted).toBe(10);
    }, 120_000);

    //////////////////////////////
    // The handler seam         //
    //////////////////////////////

    test("the handler sees every case and the failing one", async () => {
      const dir = await definitionDir;
      const template = await templateFor(dir, `ordered(${MARKER_X}, ${MARKER_Y})`);
      const tested: bigint[] = [];
      const failed: bigint[] = [];
      await caughtAsync(
        new KFuzz(dir, {
          handler: {
            handleTest: (subst) => void tested.push(bound(subst, VAR_X)),
            handleFailure: (subst) => void failed.push(bound(subst, VAR_X)),
          },
        }).fuzzWithCheck(template, STRATEGY, checkPassed, { seed: 20250806, numRuns: 100 }),
        KFuzzError,
      );
      expect(failed).toHaveLength(1);
      expect(tested.at(-1)).toBe(failed[0]);
    }, 120_000);
  },
);
