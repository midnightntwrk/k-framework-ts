/**
 * The `ktool` command, driven as a function.
 *
 * `main` takes argv, two sinks and a fetcher, so everything that can run
 * without K runs here: the four flag parsers (pure), `kompile --dry-run`
 * (which prints the argv and spawns nothing), `check-k` against an injected
 * fetcher, and `claims` against a **pre-seeded cache** — a `<spec>.json` whose
 * digest matches makes `ClaimLoader` skip its parser entirely, which is exactly
 * the path that needs no `kprove`.
 *
 * What cannot run here is the spawn: `ktool kompile` without `--dry-run`,
 * `ktool run` and `ktool parse` all need a real K, so what is asserted of them
 * is the argument handling and the pre-flight failures that happen before a
 * process is created.  `bin.ts` is the only file that touches `process`, and it
 * has nothing in it but the binding.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  exitCodeFor,
  main,
  parseClaimsArgs,
  parseKompileArgs,
  parseParseArgs,
  parseRunArgs,
  render,
  runRoute,
  USAGE,
} from "../src/cli.ts";
import { claimCacheFile, claimDigest, claimModuleListToDict } from "../src/claim-loader.ts";
import { buildKompileArgv } from "../src/kompile.ts";
import type { KtoolSourceFetcher } from "../src/ksources.ts";
import { decodeModuleList } from "../src/parse-modules.ts";
import { K_RELEASE, TRANSCRIBED_FROM } from "../src/version.ts";

//////////////////////////////
// Harness                  //
//////////////////////////////

/** Collects a run's two streams and its exit code. */
async function run(argv: readonly string[], fetcher?: KtoolSourceFetcher) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(
    argv,
    (text) => void out.push(text),
    (text) => void err.push(text),
    fetcher,
  );
  return { code, out: out.join(""), err: err.join("") };
}

const FIXTURES = join(import.meta.dir, "..", "fixtures");
const SPEC_K = join(FIXTURES, "upstream", "multi-claim-spec.k");
const MODULE_LIST = decodeModuleList(
  readFileSync(join(FIXTURES, "generated", "multi-claim-spec.modulelist.json"), "utf8"),
);
const IMP_HASKELL = join(import.meta.dir, "..", "..", "kompiled", "fixtures", "generated", "imp-haskell-kompiled");

const scratchDirs: string[] = [];

afterEach(async () => {
  await Promise.all(scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * A scratch copy of the vendored spec with its cache file already written and
 * already valid, so `ClaimLoader` never reaches for `kprove`.
 */
async function seededSpec(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ktool-cli-"));
  scratchDirs.push(dir);
  const spec = join(dir, "multi-claim-spec.k");
  await copyFile(SPEC_K, spec);
  // The spec has no `require`, so the digest does not depend on the include
  // path — which is what keeps this stable whether or not K is installed here.
  await writeFile(
    claimCacheFile(spec),
    JSON.stringify(claimModuleListToDict({ moduleList: MODULE_LIST, digest: claimDigest(spec) })),
    "utf8",
  );
  return spec;
}

/**
 * The two halves of every flag parser's `T | string` return, as assertions.
 *
 * Each parser answers with an invocation or with the one-line reason it could
 * not build one, and every test below wants exactly one of the two.
 */
function accepted<T>(parsed: T | string): T {
  if (typeof parsed === "string") throw new Error(`expected these flags to parse, got: ${parsed}`);
  return parsed;
}

function refusal(parsed: unknown): string {
  expect(typeof parsed).toBe("string");
  return typeof parsed === "string" ? parsed : "";
}

//////////////////////////////
// Argument handling        //
//////////////////////////////

describe("argument handling", () => {
  test("no arguments prints usage to stderr and exits 2", async () => {
    const { code, out, err } = await run([]);
    expect(code).toBe(2);
    expect(out).toBe("");
    expect(err).toContain("ktool <command>");
  });

  test("--help prints usage to stdout and exits 0", async () => {
    const { code, out, err } = await run(["--help"]);
    expect(code).toBe(0);
    expect(out).toBe(`${USAGE}\n`);
    expect(err).toBe("");
  });

  test("an unknown command exits 2 and names itself", async () => {
    const { code, err } = await run(["frobnicate"]);
    expect(code).toBe(2);
    expect(err).toContain("unknown command: frobnicate");
  });

  test("the usage names every subcommand", () => {
    for (const command of ["kompile", "run", "parse", "claims", "check-k"]) {
      expect(USAGE).toContain(`ktool ${command}`);
    }
  });
});

//////////////////////////////
// kompile                  //
//////////////////////////////

/** The argv `parseKompileArgs` produces, so the flag table is golden-tested end to end. */
function kompileArgv(args: readonly string[]): string[] {
  const parsed = parseKompileArgs(args);
  if (typeof parsed === "string") throw new Error(parsed);
  return buildKompileArgv(parsed.spec, parsed.options);
}

describe("kompile flags → argv", () => {
  test("the minimum: llvm, and --emit-json on by default (pyk's default, not the CLI's)", () => {
    expect(kompileArgv(["imp.k"])).toEqual(["kompile", "imp.k", "--emit-json", "--backend", "llvm"]);
  });

  test("--no-emit-json is the only way to get the Java frontend's default", () => {
    expect(kompileArgv(["imp.k", "--no-emit-json"])).toEqual(["kompile", "imp.k", "--backend", "llvm"]);
  });

  test("the common flags, in the library's emission order", () => {
    expect(
      kompileArgv([
        "imp.k",
        "--backend",
        "haskell",
        "--main-module",
        "IMP",
        "--syntax-module",
        "IMP-SYNTAX",
        "-I",
        "b",
        "-I",
        "a",
        "--md-selector",
        "k",
        "-o",
        "out",
      ]),
    ).toEqual([
      "kompile",
      "imp.k",
      "--main-module",
      "IMP",
      "--syntax-module",
      "IMP-SYNTAX",
      // `-I` is sorted by the library, not by the order they were typed.
      "-I",
      "a",
      "-I",
      "b",
      "--md-selector",
      "k",
      "--emit-json",
      "--backend",
      "haskell",
      "--output-definition",
      "out",
    ]);
  });

  test("-O2, -ccopt and --enable-search reach the llvm spec", () => {
    expect(kompileArgv(["imp.k", "-O2", "-ccopt", "-g", "-ccopt", "-O0", "--enable-search"])).toEqual([
      "kompile",
      "imp.k",
      "--emit-json",
      "--backend",
      "llvm",
      "-O2",
      "-ccopt",
      "-g",
      "-ccopt",
      "-O0",
      "--enable-search",
    ]);
  });

  test("--concrete-rules is comma-separated or repeated, and comma-joined into one element", () => {
    expect(kompileArgv(["imp.k", "--backend", "haskell", "--concrete-rules", "a,b", "--concrete-rules", "c"])).toEqual([
      "kompile",
      "imp.k",
      "--emit-json",
      "--backend",
      "haskell",
      "--concrete-rules",
      "a,b,c",
    ]);
  });

  test("--no-haskell-binary emits the negated flag the library owns", () => {
    expect(kompileArgv(["imp.k", "--backend", "haskell", "--no-haskell-binary"])).toContain("--no-haskell-binary");
  });

  test("-Wno accumulates and is comma-joined after the flag", () => {
    expect(kompileArgv(["imp.k", "-Wno", "non-exhaustive-match", "-Wno", "unused-var"])).toEqual([
      "kompile",
      "imp.k",
      "--emit-json",
      "--backend",
      "llvm",
      "-Wno",
      "non-exhaustive-match,unused-var",
    ]);
  });

  test("--outer-parsed-json is emitted once even though it is reachable twice", () => {
    const argv = kompileArgv(["imp.k", "--outer-parsed-json"]);
    expect(argv.filter((arg) => arg === "--outer-parsed-json")).toHaveLength(1);
  });

  test("--type-inference-mode, --warnings and the debug switches are call options", () => {
    expect(
      kompileArgv(["imp.k", "--type-inference-mode", "checked", "--warnings", "none", "--verbose", "--debug"]),
    ).toEqual([
      "kompile",
      "imp.k",
      "--emit-json",
      "--backend",
      "llvm",
      "--type-inference-mode",
      "checked",
      "--warnings",
      "none",
      "--debug",
      "--verbose",
    ]);
  });
});

describe("kompile flag errors", () => {
  const reason = (args: readonly string[]): string => refusal(parseKompileArgs(args));

  test("no main file", () => {
    expect(reason([])).toBe("takes exactly one main file");
  });

  test("two main files", () => {
    expect(reason(["a.k", "b.k"])).toContain("takes exactly one main file, got a.k and b.k");
  });

  test("a flag at the end with no value", () => {
    expect(reason(["imp.k", "--main-module"])).toBe("--main-module takes a value");
  });

  test("an unknown option is named, not ignored", () => {
    expect(reason(["imp.k", "--frobnicate"])).toBe("unknown option: --frobnicate");
  });

  test("an out-of-range enum lists what was allowed", () => {
    expect(reason(["imp.k", "--backend", "ocaml"])).toBe("--backend must be one of: llvm haskell kore maude");
    expect(reason(["imp.k", "--warnings", "loud"])).toBe("--warnings must be one of: all normal none");
  });

  test("--backend kore is rejected the way pyk's from_dict rejects it", () => {
    expect(reason(["imp.k", "--backend", "kore"])).toContain("no spec form");
  });

  test("an llvm option against another backend is named rather than dropped", () => {
    expect(reason(["imp.k", "--backend", "haskell", "--enable-search"])).toBe(
      "--enable-search is an llvm-backend option, but --backend is haskell",
    );
    expect(reason(["imp.k", "--backend", "maude", "-O2"])).toBe(
      "-O2 is an llvm-backend option, but --backend is maude",
    );
  });

  test("a haskell option against another backend, likewise", () => {
    expect(reason(["imp.k", "--concrete-rules", "a"])).toBe(
      "--concrete-rules is a haskell-backend option, but --backend is llvm",
    );
  });
});

describe("kompile --dry-run", () => {
  test("prints the argv, shell-quoted, and spawns nothing", async () => {
    const { code, out, err } = await run(["kompile", "imp.k", "--backend", "haskell", "--dry-run"]);
    expect(code).toBe(0);
    expect(err).toBe("");
    expect(out).toBe("kompile imp.k --emit-json --backend haskell\n");
  });

  test("a value needing quoting is quoted the way shlex.join quotes it", async () => {
    const { out } = await run(["kompile", "imp.k", "--post-process", 'echo "hi"', "--dry-run"]);
    expect(out).toContain(`--post-process 'echo "hi"'`);
  });

  test("a bad flag exits 2 with a one-line reason and the usage", async () => {
    const { code, out, err } = await run(["kompile", "--backend", "ocaml", "imp.k"]);
    expect(code).toBe(2);
    expect(out).toBe("");
    expect(err).toContain("kompile --backend must be one of:");
    expect(err).toContain("ktool <command>");
  });
});

//////////////////////////////
// run                      //
//////////////////////////////

describe("run flags", () => {
  const ok = (args: readonly string[]) => accepted(parseRunArgs(args));
  const reason = (args: readonly string[]): string => refusal(parseRunArgs(args));

  test("a .kore file is a configuration, anything else is a program", () => {
    expect(ok(["d", "final.kore"]).input).toBe("kore");
    expect(ok(["d", "sum.imp"]).input).toBe("program");
    expect(ok(["d", "sum.imp", "--input", "kore"]).input).toBe("kore");
  });

  test("--output defaults to pretty, as krun's does", () => {
    expect(ok(["d", "f.kore"]).output).toBe("pretty");
    expect(ok(["d", "f.kore", "--output", "json"]).output).toBe("json");
  });

  test("--depth is a non-negative integer, and 0 is a request the library forwards", () => {
    expect(ok(["d", "f.kore", "--depth", "0"]).depth).toBe(0);
    // `-1` is the *value* of `--depth`, not an option: a valued flag consumes
    // whatever follows it, which is what makes the message name the value.
    expect(reason(["d", "f.kore", "--depth", "-1"])).toBe("--depth takes a non-negative integer, got -1");
    expect(reason(["d", "f.kore", "--depth", "half"])).toBe("--depth takes a non-negative integer, got half");
  });

  test("--parser applies to program input only", () => {
    expect(ok(["d", "sum.imp", "--parser", "cat"]).parser).toBe("cat");
    expect(reason(["d", "f.kore", "--parser", "cat"])).toContain("--parser applies to program input only");
  });

  test("the two positionals are required and exact", () => {
    expect(reason(["d"])).toBe("takes exactly a kompiled directory and a file");
    expect(reason(["d", "a", "b"])).toBe("takes exactly a kompiled directory and a file");
  });

  test("latex is refused here, though kore-print's PrintOutput carries it", () => {
    // pyk's enum has `latex` and the `kore-print` script rejects it; spending a
    // process to earn a usage error is not an improvement on saying so now.
    expect(reason(["d", "f.kore", "--output", "latex"])).toBe(
      "--output must be one of: pretty program kast binary json kore none",
    );
  });
});

describe("runRoute", () => {
  test("an interpreter beats krun, and --krun beats the interpreter", () => {
    expect(runRoute(true, false)).toBe("interpreter");
    expect(runRoute(true, true)).toBe("krun");
    expect(runRoute(false, false)).toBe("krun");
  });
});

describe("run failures that happen before a process", () => {
  test("a definition directory that is not one exits 1 and says so", async () => {
    const { code, err } = await run(["run", join(IMP_HASKELL, "nope"), "f.kore"]);
    expect(code).toBe(1);
    expect(err).toContain("Directory does not exist:");
  });

  test("a missing input file exits 1", async () => {
    const { code, err } = await run(["run", IMP_HASKELL, join(IMP_HASKELL, "nope.kore")]);
    expect(code).toBe(1);
    expect(err).not.toBe("");
  });
});

//////////////////////////////
// parse                    //
//////////////////////////////

describe("parse flags", () => {
  const ok = (args: readonly string[]) => accepted(parseParseArgs(args));
  const reason = (args: readonly string[]): string => refusal(parseParseArgs(args));

  test("--sort is required, because neither parseToken nor kast has a default", () => {
    expect(reason(["d", "3 + 4"])).toBe("requires --sort");
    expect(ok(["d", "3 + 4", "--sort", "AExp"]).sort).toBe("AExp");
  });

  test("--output defaults to json", () => {
    expect(ok(["d", "x", "--sort", "K"]).output).toBe("json");
    expect(ok(["d", "x", "--sort", "K", "--output", "pretty"]).output).toBe("pretty");
    expect(reason(["d", "x", "--sort", "K", "--output", "binary"])).toBe("--output must be one of: json pretty kore");
  });

  test("--file and --as-rule are switches", () => {
    const parsed = ok(["d", "pgm.imp", "--sort", "Pgm", "--file", "--as-rule"]);
    expect(parsed.fromFile).toBe(true);
    expect(parsed.asRule).toBe(true);
  });

  test("text beginning with a dash is text, not an option", () => {
    expect(ok(["d", "-1", "--sort", "Int"]).text).toBe("-1");
    expect(reason(["d", "x", "--sort", "K", "--frobnicate"])).toBe("unknown option: --frobnicate");
  });

  test("the two positionals are required and exact", () => {
    expect(reason(["d"])).toContain("takes exactly a kompiled directory and one text");
  });
});

describe("parse failures that happen before a process", () => {
  test("a definition directory that is not one exits 1", async () => {
    const { code, err } = await run(["parse", join(IMP_HASKELL, "nope"), "3", "--sort", "AExp"]);
    expect(code).toBe(1);
    expect(err).toContain("Directory does not exist:");
  });
});

//////////////////////////////
// claims                   //
//////////////////////////////

describe("claims flags", () => {
  const reason = (args: readonly string[]): string => refusal(parseClaimsArgs(args));

  test("--definition is required: a spec is parsed against a definition", () => {
    expect(reason(["spec.k"])).toBe("requires --definition <kompiled-dir>");
  });

  test("exactly one spec file", () => {
    expect(reason(["--definition", "d"])).toBe("takes exactly one spec file");
    expect(reason(["a.k", "b.k", "--definition", "d"])).toBe("takes exactly one spec file");
  });

  test("--labels and --exclude are repeatable and comma-separated", () => {
    const parsed = parseClaimsArgs([
      "spec.k",
      "--definition",
      "d",
      "--labels",
      "a,b",
      "--labels",
      "c",
      "--exclude",
      "d",
    ]);
    if (typeof parsed === "string") throw new Error(parsed);
    expect([...(parsed.options.claimLabels ?? [])]).toEqual(["a", "b", "c"]);
    expect([...(parsed.options.excludeClaimLabels ?? [])]).toEqual(["d"]);
  });

  test("--no-depends turns off the closure, which is on by default", () => {
    const on = parseClaimsArgs(["spec.k", "--definition", "d"]);
    const off = parseClaimsArgs(["spec.k", "--definition", "d", "--no-depends"]);
    if (typeof on === "string" || typeof off === "string") throw new Error("expected both to parse");
    expect(on.options.includeDependencies).toBe(true);
    expect(off.options.includeDependencies).toBe(false);
  });

  test("--builtin-dir given means no PATH lookup", () => {
    const given = parseClaimsArgs(["spec.k", "--definition", "d", "--builtin-dir", "/k/builtin"]);
    const absent = parseClaimsArgs(["spec.k", "--definition", "d"]);
    if (typeof given === "string" || typeof absent === "string") throw new Error("expected both to parse");
    expect(given.findBuiltinDir).toBe(false);
    expect(given.options.builtinDir).toBe("/k/builtin");
    expect(absent.findBuiltinDir).toBe(true);
  });
});

describe("claims against a warm cache — the path that needs no kprove", () => {
  test("lists every label the spec resolves to, in index order", async () => {
    const spec = await seededSpec();
    const { code, out, err } = await run(["claims", spec, "--definition", IMP_HASKELL]);
    expect(err).toBe("");
    expect(code).toBe(0);
    expect(out.trimEnd().split("\n")).toEqual([
      "MULTI-CLAIM-SPEC-DEPENDENCY-1.dep-1.1",
      "MULTI-CLAIM-SPEC-DEPENDENCY-2.dep-2.1",
      "MULTI-CLAIM-SPEC-DEPENDENCY-2.rep-dep",
      "MULTI-CLAIM-SPEC-DEPENDENCY-2.dep-2.2",
      "5ddd2bbfcb186faba347e63f4ab5300f1faf0056075662f5e8432a0fd2e3f2bf",
      "MULTI-CLAIM-SPEC.dep",
      "MULTI-CLAIM-SPEC.rep-dep",
      "MULTI-CLAIM-SPEC.main.1",
      "MULTI-CLAIM-SPEC.main.3",
      "f5513267556f9bea2efb8bbb579cfd2aecf60509a7fa2f5996d7f434c9728d6a",
    ]);
  });

  test("--labels closes over depends() by default, breadth first", async () => {
    const spec = await seededSpec();
    const { code, out } = await run([
      "claims",
      spec,
      "--definition",
      IMP_HASKELL,
      "--labels",
      "MULTI-CLAIM-SPEC-DEPENDENCY-2.dep-2.2",
    ]);
    expect(code).toBe(0);
    expect(out.trimEnd().split("\n")).toEqual([
      "MULTI-CLAIM-SPEC-DEPENDENCY-2.dep-2.2",
      "MULTI-CLAIM-SPEC-DEPENDENCY-1.dep-1.1",
    ]);
  });

  test("--no-depends keeps only what was asked for", async () => {
    const spec = await seededSpec();
    const { out } = await run([
      "claims",
      spec,
      "--definition",
      IMP_HASKELL,
      "--labels",
      "MULTI-CLAIM-SPEC-DEPENDENCY-2.dep-2.2",
      "--no-depends",
    ]);
    expect(out).toBe("MULTI-CLAIM-SPEC-DEPENDENCY-2.dep-2.2\n");
  });

  test("--ordered puts dependencies first", async () => {
    const spec = await seededSpec();
    const { out } = await run([
      "claims",
      spec,
      "--definition",
      IMP_HASKELL,
      "--labels",
      "MULTI-CLAIM-SPEC-DEPENDENCY-2.dep-2.2",
      "--ordered",
    ]);
    expect(out.trimEnd().split("\n")).toEqual([
      "MULTI-CLAIM-SPEC-DEPENDENCY-1.dep-1.1",
      "MULTI-CLAIM-SPEC-DEPENDENCY-2.dep-2.2",
    ]);
  });

  test("--ordered over the whole spec agrees with ClaimIndex.labels({ordered})", async () => {
    const spec = await seededSpec();
    const { out } = await run(["claims", spec, "--definition", IMP_HASKELL, "--ordered"]);
    expect(out.trimEnd().split("\n")).toEqual([
      "MULTI-CLAIM-SPEC-DEPENDENCY-1.dep-1.1",
      "MULTI-CLAIM-SPEC-DEPENDENCY-2.dep-2.1",
      "MULTI-CLAIM-SPEC-DEPENDENCY-2.rep-dep",
      "5ddd2bbfcb186faba347e63f4ab5300f1faf0056075662f5e8432a0fd2e3f2bf",
      "MULTI-CLAIM-SPEC.dep",
      "MULTI-CLAIM-SPEC.rep-dep",
      "f5513267556f9bea2efb8bbb579cfd2aecf60509a7fa2f5996d7f434c9728d6a",
      "MULTI-CLAIM-SPEC-DEPENDENCY-2.dep-2.2",
      "MULTI-CLAIM-SPEC.main.1",
      "MULTI-CLAIM-SPEC.main.3",
    ]);
  });

  test("--exclude prunes the label and the subtree under it", async () => {
    const spec = await seededSpec();
    const { out } = await run([
      "claims",
      spec,
      "--definition",
      IMP_HASKELL,
      "--labels",
      "MULTI-CLAIM-SPEC-DEPENDENCY-2.dep-2.2",
      "--exclude",
      "MULTI-CLAIM-SPEC-DEPENDENCY-1.dep-1.1",
    ]);
    expect(out).toBe("MULTI-CLAIM-SPEC-DEPENDENCY-2.dep-2.2\n");
  });

  test("a label that does not resolve exits 1 with the library's message", async () => {
    const spec = await seededSpec();
    const { code, out, err } = await run(["claims", spec, "--definition", IMP_HASKELL, "--labels", "nope"]);
    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toContain("Claim label not found: nope");
  });

  test("--verbose traces the cache decision on stderr, never on stdout", async () => {
    const spec = await seededSpec();
    const { code, out, err } = await run(["claims", spec, "--definition", IMP_HASKELL, "--verbose"]);
    expect(code).toBe(0);
    expect(err).toContain("Loading spec file:");
    expect(err).toContain("Calculated digest:");
    // The seeded cache is valid, so the parser is never reached.
    expect(err).not.toContain("Generating claim modules");
    expect(out).toContain("MULTI-CLAIM-SPEC.main.1");
  });
});

//////////////////////////////
// check-k                  //
//////////////////////////////

/** Serves every declared file with a stand-in body, so the report's shape is what is asserted. */
const standInFetcher: KtoolSourceFetcher = (repo, path) => {
  const source = TRANSCRIBED_FROM.find((s) => s.repo === repo && s.path === path);
  return Promise.resolve(source === undefined ? undefined : new TextEncoder().encode(`stand-in for ${path}`));
};

describe("check-k", () => {
  test("takes exactly one release tag", async () => {
    expect((await run(["check-k"])).code).toBe(2);
    expect((await run(["check-k", "a", "b"])).code).toBe(2);
    expect((await run(["check-k"])).err).toContain(K_RELEASE);
  });

  test("a stand-in body is drift, so both tiers report DIFF and the exit code is 1", async () => {
    const { code, out } = await run(["check-k", K_RELEASE], standInFetcher);
    expect(code).toBe(1);
    expect(out).toContain("format tier");
    expect(out).toContain("content tier");
    expect(out).toContain("DIFF");
    expect(out).toContain("format: CHANGED");
  });

  test("a 404 everywhere is 'could not locate', which is exit 3", async () => {
    const { code, out } = await run(["check-k", "v9.9.9"], () => Promise.resolve(undefined));
    expect(code).toBe(3);
    expect(out).toContain("GONE");
    expect(out).toContain("could not locate");
  });

  test("a fetcher that throws is 'could not ask', which is exit 2 — never a verdict", async () => {
    const { code, out, err } = await run(["check-k", K_RELEASE], () => Promise.reject(new Error("offline")));
    expect(code).toBe(2);
    expect(out).toBe("");
    expect(err).toContain("could not check");
    expect(err).toContain("offline");
  });

  test("every manifest entry appears in the report, with its reason", async () => {
    const { out } = await run(["check-k", K_RELEASE], standInFetcher);
    for (const source of TRANSCRIBED_FROM) expect(out).toContain(source.path);
  });
});

describe("check-k rendering", () => {
  test("exitCodeFor is the contract the usage states", () => {
    expect(exitCodeFor("unchanged")).toBe(0);
    expect(exitCodeFor("changed")).toBe(1);
    expect(exitCodeFor("could-not-locate")).toBe(3);
  });

  test("an all-clear report says so on both tiers", () => {
    const text = render({
      release: K_RELEASE,
      recordedAt: K_RELEASE,
      verdicts: { format: "unchanged", content: "unchanged" },
      files: [],
    });
    expect(text).toContain("format: unchanged");
    expect(text).toContain("content (advisory): unchanged");
  });
});
