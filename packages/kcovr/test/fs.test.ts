/**
 * The directory loader — the file-discovery half of `create_cover_map`
 * (`kcovr.py:197-217`) and `create_rule_map` (`:178-194`).
 *
 * Almost all of it is about what may be *missing*.  pyk opens `coverage.txt`
 * unguarded (`:206`) and `allRules.txt` unguarded (`:182`), so a definition
 * built by a `kompile` that wrote no macro log, or a directory that is not a
 * definition at all, both come back as a bare `FileNotFoundError` naming a path
 * the user did not type.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderCoverageReport } from "../src/cobertura.ts";
import { MissingCoverageFileError } from "../src/errors.ts";
import {
  ALL_RULES_NAME,
  COVERAGE_LOG_GLOB,
  coverageLogNames,
  HIT_LOGS_ARE_APPEND_ONLY,
  MACRO_LOG_NAME,
  readCoverageDefinition,
  readCoverageDefinitions,
  resolveSourcePath,
} from "../src/fs.ts";

const FIXTURE_DIR = join(import.meta.dir, "..", "fixtures", "cov-build");

const scratches: string[] = [];

/** A throwaway definition directory: `{ file: contents }`. */
async function scratchDir(files: Readonly<Record<string, string>>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "kframework-ts-kcovr-fs-"));
  scratches.push(dir);
  await Promise.all(Object.entries(files).map(([name, text]) => writeFile(join(dir, name), text)));
  return dir;
}

afterAll(async () => {
  await Promise.all(scratches.map((dir) => rm(dir, { recursive: true, force: true })));
});

const ruleId = (n: number): string => n.toString(16).padStart(64, "0");

describe("the real --coverage build", () => {
  test("reads allRules.txt and every log, macro log first", async () => {
    const definition = await readCoverageDefinition(FIXTURE_DIR);
    expect(definition.name).toBe(FIXTURE_DIR);
    expect(definition.allRulesTxt.split("\n").filter((l) => l !== "")).toHaveLength(168);
    // coverage.txt, then the three `*_coverage.txt` sorted by name.
    expect(definition.coverageLogs).toHaveLength(4);
    expect(definition.coverageLogs[0]).toBe("");
  });

  test("the empty coverage.txt is read, not skipped, and does not crash", async () => {
    const names = await coverageLogNames(FIXTURE_DIR);
    expect(names).toEqual([MACRO_LOG_NAME, "pid-large_coverage.txt", "pid-mid_coverage.txt", "pid-small_coverage.txt"]);
  });

  test("the glob is sorted, so two runs produce the same bytes", async () => {
    // `Path.glob` order is whatever the OS hands back; counts do not depend on
    // it, but `kcovr hits`' output should not change between machines.
    const globbed = (await coverageLogNames(FIXTURE_DIR)).filter((name) => name !== MACRO_LOG_NAME);
    expect(globbed).toEqual(globbed.toSorted());
  });
});

describe("what may be missing", () => {
  test("no coverage.txt is fine — pyk raises FileNotFoundError", async () => {
    const dir = await scratchDir({
      [ALL_RULES_NAME]: `${ruleId(0)} /s/a.k:1:1`,
      "1234_coverage.txt": `${ruleId(0)}\n`,
    });
    const definition = await readCoverageDefinition(dir);
    expect(definition.coverageLogs).toEqual([`${ruleId(0)}\n`]);
  });

  test("no hit log at all is a built-but-never-run definition", async () => {
    const dir = await scratchDir({ [ALL_RULES_NAME]: `${ruleId(0)} /s/a.k:1:1` });
    const definition = await readCoverageDefinition(dir);
    expect(definition.coverageLogs).toEqual([]);
    const report = renderCoverageReport([definition], ["/s/a.k"], { timestamp: 0 });
    expect(report.xml).toInclude('line-rate="0.0"');
  });

  test("no allRules.txt is an error that says which file and where", async () => {
    const dir = await scratchDir({ "1234_coverage.txt": "" });

    let failure: unknown;
    try {
      await readCoverageDefinition(dir);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(MissingCoverageFileError);
    expect(failure).toMatchObject({ dir, file: ALL_RULES_NAME });
    // pyk's is a bare FileNotFoundError naming a path the user never typed.
    expect(failure instanceof Error ? failure.message : "").toInclude("Kompile.java:363-382");
  });
});

describe("the filename grammar", () => {
  test("a K_LOG_PREFIX-prefixed log is matched by the same glob", async () => {
    // `io.cpp:539-551`: <K_LOG_DIR|dirname>/<K_LOG_PREFIX><pid>_coverage.txt.
    const dir = await scratchDir({
      [ALL_RULES_NAME]: `${ruleId(0)} /s/a.k:1:1`,
      "myprefix-9931_coverage.txt": `${ruleId(0)}\n`,
    });
    expect(await coverageLogNames(dir)).toEqual(["myprefix-9931_coverage.txt"]);
    expect(COVERAGE_LOG_GLOB).toBe("*_coverage.txt");
  });

  test("unrelated files in the directory are ignored", async () => {
    const dir = await scratchDir({
      [ALL_RULES_NAME]: `${ruleId(0)} /s/a.k:1:1`,
      "definition.kore": "x",
      "coverage.txt.bak": "x",
      "1_coverage.txt": "",
    });
    expect(await coverageLogNames(dir)).toEqual(["1_coverage.txt"]);
  });

  test("append-only accumulation is stated, not silently assumed", () => {
    // `io.cpp:552` opens "a+" and `:566` flushes at exit, so re-running without
    // deleting doubles every count.  Nothing here deletes anything.
    expect(HIT_LOGS_ARE_APPEND_ONLY).toBe(true);
    const doubled = renderCoverageReport(
      [{ allRulesTxt: `${ruleId(0)} /s/a.k:1:1`, coverageLogs: [`${ruleId(0)}\n${ruleId(0)}\n`] }],
      ["/s/a.k"],
      { timestamp: 0 },
    );
    expect(doubled.xml).toInclude('hits="2"');
  });
});

describe("several definition directories", () => {
  test("merge into one rule map and one counter", async () => {
    const first = await scratchDir({
      [ALL_RULES_NAME]: `${ruleId(0)} /s/a.k:1:1`,
      "1_coverage.txt": `${ruleId(0)}\n${ruleId(0)}\n`,
    });
    const second = await scratchDir({
      [ALL_RULES_NAME]: `${ruleId(1)} /s/b.k:1:1`,
      "2_coverage.txt": `${ruleId(1)}\n`,
    });

    const definitions = await readCoverageDefinitions([first, second]);
    const report = renderCoverageReport(definitions, ["/s/a.k", "/s/b.k"], { timestamp: 0 });

    expect(report.ruleMap.size).toBe(2);
    expect(report.coverMap.get(ruleId(0))).toBe(2);
    expect(report.coverMap.get(ruleId(1))).toBe(1);
    expect(report.xml).toInclude('line-rate="1.0" branch-rate="1.0"');
    expect([...report.xml.matchAll(/<class name="([^"]+)"/gu)].map((m) => m[1])).toEqual(["a.k", "b.k"]);
  });

  test("keep the order they were given in", async () => {
    const first = await scratchDir({ [ALL_RULES_NAME]: `${ruleId(0)} /s/a.k:1:1` });
    const second = await scratchDir({ [ALL_RULES_NAME]: `${ruleId(1)} /s/b.k:1:1` });
    const definitions = await readCoverageDefinitions([second, first]);
    expect(definitions.map((d) => d.name)).toEqual([second, first]);
  });
});

describe("the ./fs split", () => {
  test("the package root re-exports nothing from this module", async () => {
    // `import "@kframework-ts/kcovr"` must not pull `node:fs` into the module
    // graph — the reason this file is behind a subpath at all.
    const barrel = await import("../src/index.ts");
    for (const name of [
      "readCoverageDefinition",
      "readCoverageDefinitions",
      "coverageLogNames",
      "resolveSourcePath",
      "readTextFile",
      "readKompiledJsonDefinition",
      // The path-taking half of `translate_coverage_from_paths`; only its
      // fs-free twin, `translateCoverageFromDefinitions`, is on the root.
      "translateCoverageFromPaths",
    ]) {
      expect(barrel).not.toHaveProperty(name);
    }
    for (const name of [
      "createCoverMap",
      "renderCoverageXml",
      "createRuleMap",
      "formatPythonFloat",
      "KcovrError",
      "getRuleById",
      "stripCoverageLogger",
      "translateCoverage",
      "translateCoverageFromDefinitions",
      "parseRuleApplications",
      "renderKoreExecReport",
    ]) {
      expect(barrel).toHaveProperty(name);
    }
  });
});

describe("resolveSourcePath", () => {
  test("leaves an absolute path exactly as allRules.txt would write it", () => {
    // Including sanitized roots that exist on no machine, which is what makes
    // the fixture corpus reportable at all.
    expect(resolveSourcePath("/fix/sem/panopticon-syntax.md")).toBe("/fix/sem/panopticon-syntax.md");
  });

  test("resolves a relative path against the working directory, as pyk does", () => {
    expect(resolveSourcePath("a.md").startsWith("/")).toBe(true);
    expect(resolveSourcePath("a.md").endsWith("/a.md")).toBe(true);
  });
});
