import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CoverageLogDirError } from "../src/errors.ts";
import { coverageLogEnv, coverageLogName, K_LOG_DIR_ENV, K_LOG_PREFIX_ENV, parseCoverageLogName } from "../src/log.ts";
import { checkCoverageLogDir, coverageLogEntries, MACRO_LOG_NAME } from "../src/fs.ts";

const scratches: string[] = [];

async function scratchDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "kframework-ts-kcovr-log-"));
  scratches.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(scratches.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function expectDirectoryError(action: Promise<void>, expected: Partial<CoverageLogDirError>): Promise<void> {
  try {
    await action;
    throw new Error("expected a CoverageLogDirError");
  } catch (error) {
    expect(error).toBeInstanceOf(CoverageLogDirError);
    expect(error).toMatchObject(expected);
  }
}

describe("LLVM coverage-log names", () => {
  test("builds and parses finite non-negative integer pids", () => {
    expect(coverageLogName(0)).toBe("0_coverage.txt");
    expect(coverageLogName(42, "case-")).toBe("case-42_coverage.txt");
    expect(parseCoverageLogName("case-0042_coverage.txt")).toEqual({
      attribution: "heuristic",
      ambiguous: true,
      prefix: "case-",
      pid: 42,
    });
    expect(parseCoverageLogName("case-0042_coverage.txt", "case-")).toEqual({
      attribution: "exact",
      ambiguous: false,
      prefix: "case-",
      pid: 42,
    });
    for (const pid of [-1, 1.5, Number.POSITIVE_INFINITY, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => coverageLogName(pid)).toThrow(RangeError);
    }
  });

  test("makes digit-ending-prefix ambiguity explicit and supports exact-prefix attribution", () => {
    expect(parseCoverageLogName("case1-42_coverage.txt")).toEqual({
      attribution: "heuristic",
      ambiguous: true,
      prefix: "case1-",
      pid: 42,
    });
    expect(parseCoverageLogName("x7_coverage.txt")).toEqual({
      attribution: "heuristic",
      ambiguous: false,
      prefix: "x",
      pid: 7,
    });
    expect(parseCoverageLogName("case142_coverage.txt")).toEqual({
      attribution: "heuristic",
      ambiguous: true,
      prefix: "case",
      pid: 142,
    });
    expect(parseCoverageLogName("case142_coverage.txt", "case1")).toEqual({
      attribution: "exact",
      ambiguous: false,
      prefix: "case1",
      pid: 42,
    });
    expect(parseCoverageLogName("case142_coverage.txt", "case")).toEqual({
      attribution: "exact",
      ambiguous: false,
      prefix: "case",
      pid: 142,
    });
    expect(parseCoverageLogName("case142_coverage.txt", "other-")).toBeUndefined();
  });

  test("rejects macro, foreign, malformed, and unrepresentable names", () => {
    for (const name of [MACRO_LOG_NAME, "notes.txt", "prefix_coverage.txt", `${"9".repeat(400)}_coverage.txt`]) {
      expect(parseCoverageLogName(name)).toBeUndefined();
    }
  });
});

describe("coverageLogEnv", () => {
  test("merges a base, drops undefined values, and overrides both runtime variables", () => {
    expect(
      coverageLogEnv(
        { dir: "/logs", prefix: "case-" },
        { PATH: "/bin", OMIT: undefined, [K_LOG_DIR_ENV]: "/old", [K_LOG_PREFIX_ENV]: "old-" },
      ),
    ).toEqual({ PATH: "/bin", [K_LOG_DIR_ENV]: "/logs", [K_LOG_PREFIX_ENV]: "case-" });
    expect(coverageLogEnv({ dir: "/logs" }, { [K_LOG_PREFIX_ENV]: "inherited-" })[K_LOG_PREFIX_ENV]).toBe("");
  });
});

describe("coverage log filesystem boundary", () => {
  test("classifies macro, attributable, and foreign coverage-shaped files in name order", async () => {
    const dir = await scratchDir();
    await Promise.all(
      [MACRO_LOG_NAME, "z-2_coverage.txt", "a-001_coverage.txt", "foreign_coverage.txt", "ignored.txt"].map((name) =>
        writeFile(join(dir, name), ""),
      ),
    );
    expect(await coverageLogEntries(dir)).toEqual([
      {
        name: "a-001_coverage.txt",
        isMacroLog: false,
        attribution: "heuristic",
        ambiguous: true,
        prefix: "a-",
        pid: 1,
      },
      { name: MACRO_LOG_NAME, isMacroLog: true, attribution: "macro" },
      { name: "foreign_coverage.txt", isMacroLog: false, attribution: "unattributed" },
      {
        name: "z-2_coverage.txt",
        isMacroLog: false,
        attribution: "heuristic",
        ambiguous: false,
        prefix: "z-",
        pid: 2,
      },
    ]);
  });

  test("uses the expected prefix for exact attribution and leaves mismatches unattributed", async () => {
    const dir = await scratchDir();
    await Promise.all(
      [MACRO_LOG_NAME, "case10042_coverage.txt", "case142_coverage.txt", "other-9_coverage.txt"].map((name) =>
        writeFile(join(dir, name), ""),
      ),
    );

    expect(await coverageLogEntries(dir, "case1")).toEqual([
      {
        name: "case10042_coverage.txt",
        isMacroLog: false,
        attribution: "exact",
        ambiguous: false,
        prefix: "case1",
        pid: 42,
      },
      {
        name: "case142_coverage.txt",
        isMacroLog: false,
        attribution: "exact",
        ambiguous: false,
        prefix: "case1",
        pid: 42,
      },
      { name: MACRO_LOG_NAME, isMacroLog: true, attribution: "macro" },
      { name: "other-9_coverage.txt", isMacroLog: false, attribution: "unattributed" },
    ]);
  });

  test("preflights missing paths, files, and writable directories", async () => {
    const dir = await scratchDir();
    await checkCoverageLogDir(dir);

    const missing = join(dir, "missing");
    await expectDirectoryError(checkCoverageLogDir(missing), {
      name: "CoverageLogDirError",
      dir: missing,
      reason: "missing",
    });

    const file = join(dir, "not-a-directory");
    await writeFile(file, "");
    await expectDirectoryError(checkCoverageLogDir(file), {
      reason: "not-directory",
    });
  });

  test("rejects an unwritable directory when the platform enforces permission bits", async () => {
    const dir = await scratchDir();
    await chmod(dir, 0o500);
    try {
      await expectDirectoryError(checkCoverageLogDir(dir), {
        reason: "unwritable",
      });
    } finally {
      await chmod(dir, 0o700);
    }
  });
});
