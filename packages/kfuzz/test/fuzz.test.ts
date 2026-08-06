/**
 * The whole fuzz loop — `fuzz` and `KFuzz` (`kfuzz.py:53-109,138-206`) —
 * against a **fake interpreter**.
 *
 * The `interpret` seam takes the place of the LLVM binary, so every case here
 * runs thousands of substitutions in milliseconds with no K, no spawn and no
 * filesystem.  What is being tested is the loop: mode exclusion, the
 * substitution reaching the interpreter, the handler call sites and their
 * order, the grading, seeds and replay, and the error the caller gets.
 *
 * `test/live-k.test.ts` is the other half — the same loop with a real
 * `kompile --backend llvm` output underneath it.
 */

import { describe, expect, test } from "bun:test";
import { app, evar, koreText, KoreParser, sortApp, type EVar, type Pattern } from "@kframework-ts/kore";
import { intDv } from "@kframework-ts/kore/prelude";

import { ExitCodeAssertionError, KFuzzArgumentError, KFuzzError } from "../src/errors.ts";
import { DEFAULT_DEADLINE_MS, fuzz, KFuzz, type Interpret, type InterpretResult } from "../src/fuzz.ts";
import type { KFuzzHandler } from "../src/handler.ts";
import { kintegers } from "../src/strategies.ts";
import { substituteVars, type KoreSubst } from "../src/subst.ts";
import { causeOf, caughtAsync } from "./caught.ts";

const INT = sortApp("SortInt");
const VAR_X: EVar = evar("VarX", INT);
const VAR_Y: EVar = evar("VarY", INT);
const DIR = "/nonexistent-kompiled";

/** `Lblcheck{}(X, Y)` — the smallest template with two variables in it. */
const TEMPLATE: Pattern = app("Lblcheck", [], [VAR_X, VAR_Y]);

const STRATEGY: readonly (readonly [EVar, ReturnType<typeof kintegers>])[] = [
  [VAR_X, kintegers({ minValue: 0, maxValue: 20 })],
  [VAR_Y, kintegers({ minValue: 0, maxValue: 20 })],
];

function completed(fields: Partial<InterpretResult> = {}): InterpretResult {
  return { returncode: 0, stdout: "Lblok{}()", stderr: "", ...fields };
}

/** An interpreter that records what it was handed and answers `fields`. */
function recording(fields: (kore: string) => InterpretResult): { interpret: Interpret; seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    interpret: (dir, kore) => {
      expect(dir).toBe(DIR);
      seen.push(kore);
      return Promise.resolve(fields(kore));
    },
  };
}

/** The two integers a `Lblcheck{}` term was built from. */
function argsOf(kore: string): readonly bigint[] {
  const pattern = new KoreParser(kore).pattern();
  if (pattern.tag !== "App") throw new Error(`not an application: ${kore}`);
  return pattern.args.map((arg) => {
    if (arg.tag !== "DV") throw new Error(`not a domain value: ${koreText(arg)}`);
    return BigInt(arg.value.value);
  });
}

/**
 * A `SubstFunction` that only descends the template's first argument — the
 * shape of upstream's `subst_on_k_cell` (`test_fuzz.py:41-61`), which
 * substitutes only inside the `<k>` cell.
 */
function firstArgumentOnly(template: Pattern, subst: KoreSubst): Pattern {
  if (template.tag !== "App") throw new Error("unexpected template");
  const [first, second] = template.args;
  return app(template.symbol, [], [substituteVars(first!, subst), second!]);
}

//////////////////////////////
// Mode exclusion           //
//////////////////////////////

describe("the check-mode exclusion (`kfuzz.py:175-176`)", () => {
  test("neither mode is upstream's RuntimeError, message for message", async () => {
    const error = await caughtAsync(fuzz(DIR, TEMPLATE, STRATEGY), KFuzzArgumentError);
    expect(error.message).toBe("Must pass one of check_func or check_exit_code, and not both!");
  });

  test("both modes is the same error", async () => {
    const options = { checkFunc: (): void => {}, checkExitCode: true };
    await caughtAsync(fuzz(DIR, TEMPLATE, STRATEGY, options), KFuzzArgumentError);
  });

  test("checkExitCode: false with no checkFunc is still 'neither'", async () => {
    // `bool(check_func) == check_exit_code` with both falsy — upstream raises.
    await caughtAsync(fuzz(DIR, TEMPLATE, STRATEGY, { checkExitCode: false }), KFuzzArgumentError);
  });

  test("the exclusion is checked before anything is generated or run", async () => {
    const { seen } = recording(() => completed());
    await caughtAsync(fuzz(DIR, TEMPLATE, STRATEGY, {}), KFuzzArgumentError);
    expect(seen).toHaveLength(0);
  });
});

//////////////////////////////
// The generated case       //
//////////////////////////////

describe("what reaches the interpreter", () => {
  test("the template arrives substituted, as KORE text, once per case", async () => {
    const { interpret, seen } = recording(() => completed());
    const report = await fuzz(DIR, TEMPLATE, STRATEGY, {
      checkFunc: () => {},
      interpret,
      run: { seed: 1, numRuns: 25 },
    });
    expect(report.numRuns).toBe(25);
    expect(seen).toHaveLength(25);
    for (const kore of seen) {
      expect(kore).not.toContain("VarX");
      const [x, y] = argsOf(kore);
      expect(x! >= 0n && x! <= 20n).toBe(true);
      expect(y! >= 0n && y! <= 20n).toBe(true);
    }
  });

  test("a custom substFunc is used instead — `test_fuzz.py:41-61`'s K-cell trick", async () => {
    // Substitute only inside the first argument, leaving the second variable
    // standing. The point upstream makes is performance; the point here is that
    // the hook is really the one consulted.
    const { interpret, seen } = recording(() => completed());
    await fuzz(DIR, TEMPLATE, STRATEGY, {
      checkFunc: () => {},
      interpret,
      substFunc: firstArgumentOnly,
      run: { seed: 2, numRuns: 5 },
    });
    for (const kore of seen) expect(kore).toContain("VarY : SortInt{}");
  });

  test("a template with no variables is 100 identical runs, not an error", async () => {
    const { interpret, seen } = recording(() => completed());
    await fuzz(DIR, app("Lblconst", [], [intDv(1)]), STRATEGY, {
      checkFunc: () => {},
      interpret,
      run: { seed: 3, numRuns: 4 },
    });
    expect(new Set(seen).size).toBe(1);
  });
});

//////////////////////////////
// Grading                  //
//////////////////////////////

describe("checkFunc mode", () => {
  test("the parsed output pattern is what the check function sees", async () => {
    const seenPatterns: Pattern[] = [];
    await fuzz(DIR, TEMPLATE, STRATEGY, {
      checkFunc: (pattern) => void seenPatterns.push(pattern),
      interpret: () => Promise.resolve(completed({ stdout: 'Lblres{}(\\dv{SortInt{}}("0"))' })),
      run: { seed: 4, numRuns: 3 },
    });
    expect(seenPatterns).toHaveLength(3);
    expect(koreText(seenPatterns[0]!)).toBe('Lblres{}(\\dv{SortInt{}}("0"))');
  });

  test("a throw is a failing case, and the counterexample is the substitution", async () => {
    const { interpret } = recording((kore) => completed({ stdout: kore }));
    const failure = await caughtAsync(
      fuzz(DIR, TEMPLATE, STRATEGY, {
        // Fails whenever the two draws differ, which a 21×21 space reaches fast.
        checkFunc: (pattern) => {
          const [x, y] = argsOf(koreText(pattern));
          if (x !== y) throw new Error(`x=${x} y=${y}`);
        },
        interpret,
        run: { seed: 5, numRuns: 100 },
      }),
      KFuzzError,
    );
    expect(failure.counterexample?.size).toBe(2);
    expect(failure.counterexample?.get(VAR_X)?.tag).toBe("DV");
    expect(causeOf(failure, Error).message).toMatch(/^x=\d+ y=\d+$/u);
  });

  test("an async check function is awaited", async () => {
    const failure = await caughtAsync(
      fuzz(DIR, TEMPLATE, STRATEGY, {
        checkFunc: async () => {
          await Promise.resolve();
          throw new Error("async failure");
        },
        interpret: () => Promise.resolve(completed()),
        run: { seed: 6, numRuns: 5 },
      }),
      KFuzzError,
    );
    expect(causeOf(failure, Error).message).toBe("async failure");
  });

  test("unparseable interpreter output is a failing case here, where pyk aborts the run", async () => {
    await caughtAsync(
      fuzz(DIR, TEMPLATE, STRATEGY, {
        checkFunc: () => {},
        interpret: () => Promise.resolve(completed({ stdout: "this is not KORE" })),
        run: { seed: 7, numRuns: 2 },
      }),
      KFuzzError,
    );
  });
});

describe("checkExitCode mode (`kfuzz.py:158-159`)", () => {
  test("exit 0 passes", async () => {
    const report = await fuzz(DIR, TEMPLATE, STRATEGY, {
      checkExitCode: true,
      interpret: () => Promise.resolve(completed({ returncode: 0 })),
      run: { seed: 8, numRuns: 10 },
    });
    expect(report.numRuns).toBe(10);
  });

  test("a non-zero exit fails, and says what it was — upstream's bare assert does not", async () => {
    const failure = await caughtAsync(
      fuzz(DIR, TEMPLATE, STRATEGY, {
        checkExitCode: true,
        interpret: () => Promise.resolve(completed({ returncode: 3, stderr: "boom" })),
        run: { seed: 9, numRuns: 1 },
      }),
      KFuzzError,
    );
    const cause = causeOf(failure, ExitCodeAssertionError);
    expect(cause.returncode).toBe(3);
    expect(cause.message).toBe("Interpreter exited with status 3, expected 0: boom");
  });

  test("stdout is never parsed in this mode, so garbage on it is harmless", async () => {
    await fuzz(DIR, TEMPLATE, STRATEGY, {
      checkExitCode: true,
      interpret: () => Promise.resolve(completed({ stdout: "not KORE at all" })),
      run: { seed: 10, numRuns: 3 },
    });
  });
});

//////////////////////////////
// The handler              //
//////////////////////////////

describe("KFuzzHandler (`kfuzz.py:25-50`)", () => {
  function collecting(): { handler: KFuzzHandler; log: string[] } {
    const log: string[] = [];
    return {
      log,
      handler: {
        handleTest: (subst) => void log.push(`test ${koreText(subst.get(VAR_X)!)}`),
        handleFailure: (subst) => void log.push(`fail ${koreText(subst.get(VAR_X)!)}`),
      },
    };
  }

  test("handleTest runs once per case, before the interpreter", async () => {
    const { handler, log } = collecting();
    const order: string[] = [];
    await fuzz(DIR, TEMPLATE, STRATEGY, {
      checkFunc: () => {},
      handler: {
        handleTest: (subst) => {
          order.push("test");
          return handler.handleTest(subst);
        },
        handleFailure: (subst) => void handler.handleFailure(subst),
      },
      interpret: () => {
        order.push("interpret");
        return Promise.resolve(completed());
      },
      run: { seed: 11, numRuns: 3 },
    });
    expect(log).toHaveLength(3);
    expect(order).toEqual(["test", "interpret", "test", "interpret", "test", "interpret"]);
  });

  test("handleFailure runs on the failing case only, before the error propagates", async () => {
    const { handler, log } = collecting();
    await caughtAsync(
      fuzz(DIR, TEMPLATE, STRATEGY, {
        checkFunc: () => {
          throw new Error("always");
        },
        handler,
        interpret: () => Promise.resolve(completed()),
        run: { seed: 12, numRuns: 10 },
      }),
      KFuzzError,
    );
    // Shrinking is off by default, so the very first case fails and ends the run.
    expect(log).toHaveLength(2);
    expect(log[0]?.startsWith("test ")).toBe(true);
    expect(log[1]?.startsWith("fail ")).toBe(true);
    expect(log[0]?.slice(5)).toBe(log[1]?.slice(5));
  });

  test("an asynchronous handler is awaited — this package's addition", async () => {
    // The handler resolves on a later microtask. If it were not awaited, the
    // interpreter would run first and `handled` would lag behind `interpreted`.
    let handled = 0;
    let interpreted = 0;
    await fuzz(DIR, TEMPLATE, STRATEGY, {
      checkFunc: () => {},
      handler: {
        handleTest: async () => {
          await Promise.resolve();
          handled += 1;
        },
        handleFailure: () => {},
      },
      interpret: () => {
        interpreted += 1;
        expect(handled).toBe(interpreted);
        return Promise.resolve(completed());
      },
      run: { seed: 13, numRuns: 4 },
    });
    expect(handled).toBe(4);
  });
});

//////////////////////////////
// Seeds, replay, shrinking //
//////////////////////////////

describe("determinism and replay", () => {
  test("the same seed generates the same cases", async () => {
    const runs = await Promise.all(
      [0, 1].map(async () => {
        const { interpret, seen } = recording(() => completed());
        await fuzz(DIR, TEMPLATE, STRATEGY, { checkFunc: () => {}, interpret, run: { seed: 4242, numRuns: 20 } });
        return seen;
      }),
    );
    expect(runs[0]).toEqual(runs[1]);
  });

  test("a different seed generates different cases", async () => {
    const seenFor = async (seed: number): Promise<readonly string[]> => {
      const { interpret, seen } = recording(() => completed());
      await fuzz(DIR, TEMPLATE, STRATEGY, { checkFunc: () => {}, interpret, run: { seed, numRuns: 20 } });
      return seen;
    };
    expect(await seenFor(1)).not.toEqual([...(await seenFor(2))]);
  });

  test("the seed is reported even when it was not supplied", async () => {
    const report = await fuzz(DIR, TEMPLATE, STRATEGY, {
      checkFunc: () => {},
      interpret: () => Promise.resolve(completed()),
      run: { numRuns: 2 },
    });
    expect(Number.isFinite(report.seed)).toBe(true);
  });

  test("a failure's seed and path replay exactly that counterexample", async () => {
    const failing = {
      checkFunc: (pattern: Pattern): void => {
        const [x] = argsOf(koreText(pattern));
        if (x! > 10n) throw new Error(`too big: ${x}`);
      },
    };
    const { interpret } = recording((kore) => completed({ stdout: kore }));
    const first = await caughtAsync(
      fuzz(DIR, TEMPLATE, STRATEGY, { ...failing, interpret, run: { seed: 77, numRuns: 100 } }),
      KFuzzError,
    );
    expect(first.path).toBeString();

    const replayed = await caughtAsync(
      fuzz(DIR, TEMPLATE, STRATEGY, {
        ...failing,
        interpret,
        run: { seed: first.seed, path: first.path!, numRuns: 100 },
      }),
      KFuzzError,
    );
    expect(koreText(replayed.counterexample!.get(VAR_X)!)).toBe(koreText(first.counterexample!.get(VAR_X)!));
    expect(replayed.numRuns).toBe(1);
  });

  test("shrinking is off by default and on by request", async () => {
    const failing = {
      checkFunc: (pattern: Pattern): void => {
        const [x] = argsOf(koreText(pattern));
        if (x! > 3n) throw new Error(`too big: ${x}`);
      },
      interpret: recording((kore) => completed({ stdout: kore })).interpret,
    };
    const unshrunk = await caughtAsync(
      fuzz(DIR, TEMPLATE, STRATEGY, { ...failing, run: { seed: 99, numRuns: 100 } }),
      KFuzzError,
    );
    expect(unshrunk.numShrinks).toBe(0);

    const shrunk = await caughtAsync(
      fuzz(DIR, TEMPLATE, STRATEGY, { ...failing, run: { seed: 99, numRuns: 100, shrink: true } }),
      KFuzzError,
    );
    expect(shrunk.numShrinks).toBeGreaterThan(0);
    // The minimal `x` that violates `x <= 3`.
    expect(koreText(shrunk.counterexample!.get(VAR_X)!)).toBe('\\dv{SortInt{}}("4")');
  });

  test("examples run first — hypothesis' Phase.explicit", async () => {
    const { interpret, seen } = recording(() => completed());
    const example: KoreSubst = new Map([
      [VAR_X, intDv(1234)],
      [VAR_Y, intDv(5678)],
    ]);
    await fuzz(DIR, TEMPLATE, STRATEGY, {
      checkFunc: () => {},
      interpret,
      run: { seed: 14, numRuns: 5, examples: [example] },
    });
    expect(argsOf(seen[0]!)).toEqual([1234n, 5678n]);
  });

  test("the deadline default is upstream's five seconds", () => {
    expect(DEFAULT_DEADLINE_MS).toBe(5000);
  });
});

//////////////////////////////
// The KFuzz façade         //
//////////////////////////////

describe("KFuzz (`kfuzz.py:53-109`)", () => {
  test("fuzzWithCheck binds the definition directory, handler and substFunc", async () => {
    const { interpret, seen } = recording(() => completed());
    const kfuzz = new KFuzz(DIR, { interpret });
    const report = await kfuzz.fuzzWithCheck(TEMPLATE, STRATEGY, () => {}, { seed: 15, numRuns: 6 });
    expect(report.numRuns).toBe(6);
    expect(seen).toHaveLength(6);
  });

  test("fuzzWithExitCode grades on the status instead", async () => {
    const kfuzz = new KFuzz(DIR, { interpret: () => Promise.resolve(completed({ returncode: 1 })) });
    const failure = await caughtAsync(kfuzz.fuzzWithExitCode(TEMPLATE, STRATEGY, { seed: 16, numRuns: 1 }), KFuzzError);
    expect(causeOf(failure, ExitCodeAssertionError).returncode).toBe(1);
  });

  test("the constructor's defaults are pyk's, and are readable", () => {
    const kfuzz = new KFuzz(DIR);
    expect(kfuzz.definitionDir).toBe(DIR);
    expect(kfuzz.substFunc).toBe(substituteVars);
    expect(kfuzz.handler.handleTest(new Map())).toBeUndefined();
  });
});
