/**
 * The `kcovr` command — `pyk-covr`'s three-line `main` (`kcovr.py:52-73`),
 * `pyk coverage` (`__main__.py:403-413`), `kore-exec-covr`
 * (`kore_exec_covr/__main__.py`), a CLI for `translate_coverage_from_paths`
 * (`coverage.py:108-133`) that upstream never wrote, and the `hits` view that
 * has no upstream equivalent either.
 *
 * `main` is a pure function of `(argv, out, err, clock)`, so every case here
 * runs in-process: no spawn, no temp shell, and the clock is pinned rather than
 * read.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  Atts,
  attEntry,
  definitionToDict,
  KAtt,
  kapply,
  kflatmodule,
  krewrite,
  krule,
  ktoken,
  KDefinition,
  type KRule,
} from "@kframework-ts/kast";

import { exitCodeFor, main, USAGE } from "../src/cli.ts";
import type { KcovrSourceFetcher } from "../src/ksources.ts";
import { K_RELEASE, TRANSCRIBED_FROM } from "../src/version.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures");
const COV_BUILD = join(FIXTURES, "cov-build");
const COMPILED = join(FIXTURES, "compiled");
const GOLDEN = readFileSync(join(FIXTURES, "synthetic", "golden.cobertura.xml"), "utf8");

const GOLDEN_SOURCES = [
  "/fix/k/include/kframework/builtin/domains.md",
  "/fix/sem/panopticon-semantics.md",
  "/fix/sem/panopticon-syntax.md",
];

/** The fetcher every non-`check-k` case gets: reaching GitHub here is a bug. */
const OFFLINE: KcovrSourceFetcher = () => {
  throw new Error("no test may reach the network");
};

/**
 * Serves a stand-in body for every declared path.  Finding a sha256 preimage is
 * not on the menu, so this reads as `changed` everywhere — which is what
 * exercises the DIFF rendering.
 */
const standInFetcher: KcovrSourceFetcher = (repo, path) => {
  const source = TRANSCRIBED_FROM.find((s) => s.repo === repo && s.path === path);
  return Promise.resolve(source === undefined ? undefined : new TextEncoder().encode(`stand-in for ${path}`));
};

/**
 * Upstream has none of the declared paths at this tag.  `undefined` is the
 * fetcher's contract for a clean 404, not a stray value.
 */
// oxlint-disable-next-line unicorn/no-useless-undefined
const goneFetcher: KcovrSourceFetcher = () => Promise.resolve(undefined);

/** Run the CLI, collecting both streams.  The clock is fixed at 2001-09-09. */
function run(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  return runWith(OFFLINE, ...argv);
}

/** The same, with `check-k`'s fetcher injected. */
async function runWith(
  fetcher: KcovrSourceFetcher,
  ...argv: string[]
): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await main(
    argv,
    (text) => {
      out += text;
    },
    (text) => {
      err += text;
    },
    () => 1_000_000_000_000,
    fetcher,
  );
  return { code, out, err };
}

const lines = (text: string): string[] => text.split("\n").filter((line) => line !== "");

const scratches: string[] = [];
const ruleId = (n: number): string => n.toString(16).padStart(64, "0");

async function scratchDir(files: Readonly<Record<string, string>>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "kframework-ts-kcovr-cli-"));
  scratches.push(dir);
  await Promise.all(Object.entries(files).map(([name, text]) => writeFile(join(dir, name), text)));
  return dir;
}

afterAll(async () => {
  await Promise.all(scratches.map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * A `compiled.json`, envelope and all — what `kompile --emit-json` writes and
 * what `readKompiledJsonDefinition` reads.
 */
const compiledJson = (definition: KDefinition): string =>
  JSON.stringify({ format: "KAST", version: 4, term: definitionToDict(definition) });

/** A `<generatedTop>`-rooted rule with the given id and attributes. */
const semanticRule = (id: string, ...extra: readonly ReturnType<typeof attEntry>[]): KRule =>
  krule(krewrite(kapply("<generatedTop>", [ktoken("0", "Int")]), kapply("<generatedTop>", [ktoken("1", "Int")])), {
    att: new KAtt([attEntry(Atts.UNIQUE_ID, id), ...extra]),
  });

const definitionOf = (...rules: readonly KRule[]): KDefinition =>
  new KDefinition("TEST", [kflatmodule("TEST", { sentences: rules })]);

describe("kcovr report", () => {
  test("prints the golden document and nothing else", async () => {
    const { code, out, err } = await run("report", COV_BUILD, "--timestamp", "0", "++", ...GOLDEN_SOURCES);
    expect(code).toBe(0);
    expect(err).toBe("");
    // Verbatim: `print(xml)` would add a second trailing newline.
    expect(out).toBe(GOLDEN);
  });

  test("accepts `--` as the separator, which pyk-covr rejects", async () => {
    // `pyk-covr` implements only `++` (`:65`) but documents `--` (`:60`), and
    // `bin/kcovr:20` implements `--`; passing `--` to pyk-covr fails with
    // "Directory does not exist: …/--".
    const plus = await run("report", COV_BUILD, "--timestamp", "0", "++", ...GOLDEN_SOURCES);
    const dash = await run("report", COV_BUILD, "--timestamp", "0", "--", ...GOLDEN_SOURCES);
    expect(dash.code).toBe(0);
    expect(dash.out).toBe(plus.out);
  });

  test("falls back to the clock, in whole seconds", async () => {
    const { out } = await run("report", COV_BUILD, "++", ...GOLDEN_SOURCES);
    expect(out).toInclude('timestamp="1000000000"');
  });

  test("warns on stderr about stale hit ids and still prints the report", async () => {
    const dir = await scratchDir({
      "allRules.txt": `${ruleId(0)} /s/a.k:1:1`,
      "9_coverage.txt": `${ruleId(0)}\n${"f".repeat(64)}\n`,
    });
    const { code, out, err } = await run("report", dir, "--timestamp", "0", "++", "/s/a.k");
    expect(code).toBe(0);
    expect(err).toInclude("warning: 1 rule id");
    expect(err).toInclude("f".repeat(64));
    expect(err).toInclude("append-only");
    // 1 of 1 known rule covered — the stale id is not in the numerator.
    expect(out).toInclude('line-rate="1.0" branch-rate="1.0"');
  });

  test("a missing separator is a usage error, not an empty report", async () => {
    // `split_at_sep` (`:63-67`) returns everything as a definition directory.
    const { code, out, err } = await run("report", COV_BUILD, "/s/a.k");
    expect(code).toBe(2);
    expect(out).toBe("");
    expect(err).toInclude("++ <source-file>");
  });

  test("rejects a non-numeric --timestamp and an unknown option", async () => {
    expect((await run("report", COV_BUILD, "--timestamp", "soon", "++", "/s/a.k")).code).toBe(2);
    expect((await run("report", COV_BUILD, "--timestamp", "++", "/s/a.k")).code).toBe(2);
    expect((await run("report", COV_BUILD, "--verbose", "++", "/s/a.k")).code).toBe(2);
  });

  test("an unreadable definition directory exits 1 with a message that names it", async () => {
    const { code, err } = await run("report", join(FIXTURES, "no-such-dir"), "++", "/s/a.k");
    expect(code).toBe(1);
    expect(err).toInclude("allRules.txt");
    expect(err).toInclude("no-such-dir");
  });

  test("reports over several definition directories at once", async () => {
    const first = await scratchDir({
      "allRules.txt": `${ruleId(0)} /s/a.k:1:1`,
      "1_coverage.txt": `${ruleId(0)}\n`,
    });
    const second = await scratchDir({ "allRules.txt": `${ruleId(1)} /s/b.k:1:1` });
    const { code, out } = await run("report", first, second, "--timestamp", "0", "++", "/s/a.k", "/s/b.k");
    expect(code).toBe(0);
    expect(out).toInclude('complexity="2.0"');
    expect(out).toInclude('branch-rate="0.5"');
  });
});

describe("kcovr hits", () => {
  test("one sorted TAB-separated line per rule that fired", async () => {
    const { code, out, err } = await run("hits", COV_BUILD);
    expect(code).toBe(0);
    expect(err).toBe("");

    const rows = lines(out);
    // The three logs hit 40 distinct rules (fixtures/PROVENANCE.md).
    expect(rows).toHaveLength(40);
    expect(rows).toEqual(rows.toSorted());

    const columns = rows.map((line) => line.split("\t"));
    for (const row of columns) {
      expect(row).toHaveLength(3);
      expect(row[0]).toMatch(/^[0-9a-f]{64}$/u);
      expect(Number(row[1])).toBeGreaterThan(0);
      expect(row[2]).toMatch(/^\/fix\/.*:\d+:\d+$/u);
    }
    // Applications, not rules: the three logs are 486 lines between them.
    expect(columns.reduce((sum, row) => sum + Number(row[1]), 0)).toBe(486);
  });

  test("marks ids allRules.txt does not know and says why on stderr", async () => {
    const dir = await scratchDir({
      "allRules.txt": `${ruleId(0)} /s/a.k:1:1`,
      "9_coverage.txt": `${ruleId(0)}\n${"f".repeat(64)}\n`,
    });
    const { code, out, err } = await run("hits", dir);
    expect(code).toBe(0);
    expect(out).toBe(`${ruleId(0)}\t1\t/s/a.k:1:1\n${"f".repeat(64)}\t1\t?\n`);
    expect(err).toInclude("not in allRules.txt");
  });

  test("a definition that never ran prints nothing at all", async () => {
    const dir = await scratchDir({ "allRules.txt": `${ruleId(0)} /s/a.k:1:1` });
    expect(await run("hits", dir)).toMatchObject({ code: 0, out: "", err: "" });
  });

  test("takes exactly one directory", async () => {
    expect((await run("hits")).code).toBe(2);
    expect((await run("hits", COV_BUILD, COV_BUILD)).code).toBe(2);
  });
});

describe("kcovr rules", () => {
  const SMALL_LOG = join(COV_BUILD, "pid-small_coverage.txt");
  // The one line in the degenerate log: `PANOPTICON-SEMANTICS.outcome-returned`.
  const SMALL_LOG_ID = "e97963c721316ecf1c6cd3355538847ef9ebbbe480cf77efe892e8508c7031fd";

  test("prints pyk's block for each id, with the coverage logger stripped", async () => {
    const { code, out, err } = await run("rules", COMPILED, SMALL_LOG);
    expect(code).toBe(0);
    // `'\n\n'`, `'Rule: ' + rid`, `'\nUnparsed:\n'`, the rule (`__main__.py:409-413`).
    expect(out).toStartWith(`\n\nRule: ${SMALL_LOG_ID}\nUnparsed:\nrule [`);
    expect(out).toEndWith("\n");
    // `strip_coverage_logger` ran: no instrumentation survives in the output.
    expect(out).not.toInclude("sideEffect:");
    expect(out).not.toInclude("#logToFile");
    // `remove_source_map` (`:405`) — no sentence keeps its Source/Location.
    expect(out).not.toInclude("org.kframework.attributes.Location(");
    // Nothing to warn about any more: this is `exec_coverage` line for line.
    expect(err).toBe("");
  });

  /**
   * `minimize_rule_like` (`__main__.py:407`) is the pass that makes the output
   * readable.  On a `kompile`d definition its most visible effect is on the
   * side conditions: every heat/cool rule carries a `requires` of the shape
   * `true andBool notBool isKResult(HOLE)`, and `andBool ∘ flatten_label`
   * drops the `true` before `simplify_bool` runs.  66 of this fixture's 168
   * rules change under it.
   */
  test("minimizes the rule, as `minimize_rule_like` does", async () => {
    // `PANOPTICON-SYNTAX.exprAdd2-heat`, whose requires is `true andBool …`.
    const heatId = "1a044eac54f99147ab39bd1fb2fa529ba7e77dd1463cd57c4cb181da25b6965b";
    const dir = await scratchDir({ "heat.txt": `${heatId}\n` });
    const { code, out } = await run("rules", COMPILED, join(dir, "heat.txt"));
    expect(code).toBe(0);
    expect(out).toInclude("notBool_ ( isKResult ( HOLE:Expr ) )");
    expect(out).not.toInclude("andBool ( true");
  });

  test("a hit log is a log: a rule prints once per application", async () => {
    const dir = await scratchDir({ "twice.txt": `${SMALL_LOG_ID}\n${SMALL_LOG_ID}\n` });
    const { out } = await run("rules", COMPILED, join(dir, "twice.txt"));
    expect(out.split(`Rule: ${SMALL_LOG_ID}`)).toHaveLength(3);
  });

  test("an id the definition does not know exits 1 with pyk's wording", async () => {
    const dir = await scratchDir({ "stale.txt": `${"0".repeat(64)}\n` });
    const { code, out, err } = await run("rules", COMPILED, join(dir, "stale.txt"));
    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toStartWith(`Could not find rule with ID: ${"0".repeat(64)}`);
  });

  test("a definition kompiled without --emit-json exits 1 and says so", async () => {
    const { code, err } = await run("rules", COV_BUILD, SMALL_LOG);
    expect(code).toBe(1);
    expect(err).toInclude("compiled.json");
    expect(err).toInclude("--emit-json");
  });

  test("an empty coverage file prints nothing and says nothing was in it", async () => {
    const dir = await scratchDir({ "empty.txt": "\n\n" });
    const { code, out, err } = await run("rules", COMPILED, join(dir, "empty.txt"));
    expect(code).toBe(0);
    expect(out).toBe("");
    expect(err).toInclude("no rule ids");
  });

  test("takes exactly a definition directory and a coverage file", async () => {
    expect((await run("rules", COMPILED)).code).toBe(2);
    expect((await run("rules", COMPILED, SMALL_LOG, "extra")).code).toBe(2);
  });
});

describe("kcovr translate", () => {
  const SRC_ALL = readFileSync(join(FIXTURES, "synthetic", "allrules-src.txt"), "utf8");
  const DST_ALL = readFileSync(join(FIXTURES, "synthetic", "allrules-dst.txt"), "utf8");
  const srcId = (n: number): string => lines(SRC_ALL)[n]?.slice(0, 64) ?? "";
  const dstId = (n: number): string => lines(DST_ALL)[n]?.slice(0, 64) ?? "";

  /** A src directory with a hit log, and a dst directory with a definition. */
  async function pair(hits: readonly string[]): Promise<{ src: string; dst: string; hitFile: string }> {
    const src = await scratchDir({ "allRules.txt": SRC_ALL, "1_coverage.txt": `${hits.join("\n")}\n` });
    const dst = await scratchDir({
      "allRules.txt": DST_ALL,
      // Every dst rule semantic except the one on the "path with spaces" line,
      // which is a function rule and must be dropped.
      "compiled.json": compiledJson(
        definitionOf(
          ...[0, 2, 3, 4].map((n) => semanticRule(dstId(n))),
          krule(krewrite(kapply("isFoo"), ktoken("true", "Bool")), {
            att: new KAtt([attEntry(Atts.UNIQUE_ID, dstId(1))]),
          }),
        ),
      ),
    });
    return { src, dst, hitFile: join(src, "1_coverage.txt") };
  }

  test("prints the destination ids, one per line, in log order", async () => {
    const { src, dst, hitFile } = await pair([srcId(4), srcId(0), srcId(4)]);
    const { code, out, err } = await run("translate", src, dst, hitFile);
    expect(code).toBe(0);
    expect(err).toBe("");
    expect(out).toBe(`${dstId(4)}\n${dstId(0)}\n${dstId(4)}\n`);
  });

  test("drops hits whose destination rule is not <generatedTop>-rooted", async () => {
    const { src, dst, hitFile } = await pair([srcId(0), srcId(1), srcId(2)]);
    const { out } = await run("translate", src, dst, hitFile);
    expect(out).toBe(`${dstId(0)}\n${dstId(2)}\n`);
  });

  test("an unknown source id exits 1 with pyk's wording", async () => {
    const unknown = "9".repeat(64);
    const { src, dst, hitFile } = await pair([unknown]);
    const { code, out, err } = await run("translate", src, dst, hitFile);
    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toStartWith(`Could not find rule in src_rule_map: ${unknown}`);
  });

  test("takes exactly three arguments", async () => {
    const { src, dst, hitFile } = await pair([]);
    expect((await run("translate", src, dst)).code).toBe(2);
    expect((await run("translate", src, dst, hitFile, "extra")).code).toBe(2);
  });
});

describe("kcovr kore-log", () => {
  const RULE_SOURCE = "/s/a.k";
  const LOG = [
    `kore-exec: [1] Debug (DebugAppliedRewriteRules): ${RULE_SOURCE}:1:1-2:2`,
    `kore-exec: [2] Debug (DebugAppliedRewriteRules): ${RULE_SOURCE}:1:1-2:2`,
    "kore-exec: [3] Debug (DebugAppliedRewriteRules):",
    "kore-exec: [4] Debug (DebugSomethingElse): noise",
    "",
  ].join("\n");

  async function fixture(): Promise<{ dir: string; logFile: string }> {
    const rule = semanticRule(
      "a".repeat(64),
      attEntry(Atts.SOURCE, RULE_SOURCE),
      attEntry(Atts.LOCATION, [1, 1, 2, 2]),
      attEntry(Atts.LABEL, "a-rule"),
    );
    const dir = await scratchDir({ "compiled.json": compiledJson(definitionOf(rule)), "run.log": LOG });
    return { dir, logFile: join(dir, "run.log") };
  }

  test("prints the report, warns about the line it could not parse", async () => {
    const { dir, logFile } = await fixture();
    const { code, out, err } = await run("kore-log", logFile, "--definition", dir);
    expect(code).toBe(0);
    expect(out).toStartWith(`Discovering rewrite and simplification rules in ${dir}\n`);
    // The typo is upstream's (`__main__.py:45-46`) and part of the contract.
    expect(out).toInclude("    Found 1 rewrite rules availible for TEST\n");
    expect(out).toInclude(`    2 applications of rule [a-rule] defined at ${RULE_SOURCE}:1:1-2:2\n`);
    expect(out).toInclude("    1 applications of rule  defined at UNKNOWN\n");
    expect(out).toEndWith("Total applied simplifications: 0\n");
    expect(err).toInclude("Skipping log entry, failed to parse: kore-exec: [4]");
  });

  test("--quiet silences the warnings but not the report", async () => {
    const { dir, logFile } = await fixture();
    const quiet = await run("kore-log", logFile, "--definition", dir, "--quiet");
    const loud = await run("kore-log", logFile, "--definition", dir);
    expect(quiet.err).toBe("");
    expect(quiet.out).toBe(loud.out);
  });

  test("--definition-dir is accepted too, as kore-exec-covr spells it", async () => {
    const { dir, logFile } = await fixture();
    const short = await run("kore-log", logFile, "--definition", dir);
    const long = await run("kore-log", logFile, "--definition-dir", dir);
    expect(long.out).toBe(short.out);
  });

  test("--help says it is legacy and points at the successor format", () => {
    expect(USAGE).toInclude("LEGACY");
    expect(USAGE).toInclude("--log-format json");
  });

  test("a missing --definition, log file or unknown option is a usage error", async () => {
    const { dir, logFile } = await fixture();
    expect((await run("kore-log", logFile)).code).toBe(2);
    expect((await run("kore-log", "--definition", dir)).code).toBe(2);
    expect((await run("kore-log", logFile, "--definition")).code).toBe(2);
    expect((await run("kore-log", logFile, "--definition", dir, "--verbose")).code).toBe(2);
    expect((await run("kore-log", logFile, logFile, "--definition", dir)).code).toBe(2);
  });
});

describe("kcovr check-k", () => {
  test("renders both tiers and exits 1 when either changed", async () => {
    const { code, out, err } = await runWith(standInFetcher, "check-k", "v9.9.9");
    expect(code).toBe(1);
    expect(err).toBe("");
    expect(out).toInclude("transcription tier");
    expect(out).toInclude("reference tier");
    expect(out).toInclude("DIFF");
    expect(out).toInclude("pyk/src/pyk/kcovr.py");
    expect(out).toInclude("test_kore_exec_covr.py");
    // Each line carries its `why`, so the report reads without the manifest.
    expect(out).toInclude("create_cover_map");
  });

  test("the reference tier is NOT advisory — it gates the exit code too", async () => {
    // Only the two reference-tier files drift; every transcription source is
    // served with the exact bytes recorded, by hashing backwards from nothing:
    // an `unchanged` verdict needs a preimage, so instead the manifest is
    // narrowed and `exitCodeFor` is asked directly about the tier pair.
    expect(exitCodeFor({ transcription: "unchanged", reference: "changed" })).toBe(1);
    expect(exitCodeFor({ transcription: "unchanged", reference: "could-not-locate" })).toBe(3);
    expect(exitCodeFor({ transcription: "unchanged", reference: "unchanged" })).toBe(0);
    // A demonstrable diff outranks an inconclusive missing path.
    expect(exitCodeFor({ transcription: "changed", reference: "could-not-locate" })).toBe(1);
    // And the report says so in prose, since the siblings' readers expect advice.
    const { out } = await runWith(standInFetcher, "check-k", "v9.9.9");
    expect(out).toInclude("Both tiers gate the exit code");
    expect(out).not.toInclude("advisory\n");
  });

  test("a path upstream does not have is GONE, and exits 3", async () => {
    const { code, out } = await runWith(goneFetcher, "check-k", "v9.9.9");
    expect(code).toBe(3);
    expect(out).toInclude("GONE");
    expect(out).toInclude("could not locate");
  });

  test("a fetcher failure exits 2 — could not ask is not a verdict", async () => {
    const { code, out, err } = await runWith(() => Promise.reject(new Error("offline")), "check-k", "v9.9.9");
    expect(code).toBe(2);
    expect(out).toBe("");
    expect(err).toInclude("could not check v9.9.9");
    expect(err).toInclude("offline");
  });

  test("missing or extra arguments exit 2, and the usage names the pinned release", async () => {
    const missing = await runWith(standInFetcher, "check-k");
    expect(missing.code).toBe(2);
    expect(missing.err).toInclude(K_RELEASE);
    expect((await runWith(standInFetcher, "check-k", "v9.9.9", "extra")).code).toBe(2);
  });

  test("--help lists it, and nothing is left unimplemented", () => {
    expect(USAGE).toInclude("kcovr check-k <k-release>");
    expect(USAGE).not.toInclude("Not implemented yet");
  });
});

describe("dispatch", () => {
  test("--help goes to stdout and exits 0", async () => {
    const { code, out, err } = await run("--help");
    expect(code).toBe(0);
    expect(out).toBe(`${USAGE}\n`);
    expect(err).toBe("");
  });

  test("no arguments prints usage to stderr and exits 2", async () => {
    const { code, out, err } = await run();
    expect(code).toBe(2);
    expect(out).toBe("");
    expect(err).toBe(`${USAGE}\n`);
  });

  test("an unknown command exits 2 and names itself", async () => {
    const { code, err } = await run("covr");
    expect(code).toBe(2);
    expect(err).toInclude("unknown command: covr");
  });

  test("the usage text warns that coverage is LLVM-only", () => {
    // `--coverage --backend haskell` compiles and never logs: the `#logToFile`
    // hook is implemented only by the LLVM backend (io.cpp:559; IO.hs:74-76).
    expect(USAGE).toInclude("LLVM-only");
  });
});
