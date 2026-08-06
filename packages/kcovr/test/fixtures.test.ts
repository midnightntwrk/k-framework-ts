/**
 * The fixture corpus, checked against what `fixtures/PROVENANCE.md` claims
 * about it.
 *
 * Phase 1 of `docs/coverage-plan.md` §7 ships fixtures and scaffolding, no
 * analysis code — so this is the whole test surface for now.  It is not
 * ceremony: PROVENANCE.md makes a couple of dozen numeric claims that phases 2
 * to 4 will build tests on top of (168 entries, 362 lines / 31 unique, 105
 * `<generatedTop>` rules, an *empty* `coverage.txt`), and a claim in prose that
 * nothing checks is a claim that rots.  Everything asserted here is quoted from
 * that document.
 *
 * It also pins the one thing a reader would otherwise get wrong about
 * `allRules.txt`: it has **no trailing newline** (`Kompile.java:381` joins with
 * `\n` rather than appending one), so `wc -l` undercounts by one.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Atts, readKastDefinitionFromJson } from "@kframework-ts/kast";

import { COVERAGE_LOG_GLOB, MACRO_LOG_NAME } from "../src/fs.ts";
import { IO_CPP_IDENTITY, K_RELEASE, TRANSCRIBED_FROM } from "../src/version.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures");

const read = (rel: string): string => readFileSync(join(FIXTURES, rel), "utf8");

/**
 * The one correct way to split a hit log or an `allRules.txt`: on `\n`,
 * dropping empties.  Neither file is newline-terminated in general, and
 * `String.split` would otherwise yield a phantom trailing entry.
 */
const lines = (text: string): string[] => text.split("\n").filter((l) => l !== "");

describe("cov-build — the real `kompile --coverage` build", () => {
  const allRules = read("cov-build/allRules.txt");

  test("has 168 entries in 167 newlines — no trailing newline", () => {
    expect(lines(allRules)).toHaveLength(168);
    expect(allRules.endsWith("\n")).toBe(false);
    // `wc -l` counts newlines, which is one fewer.  Pinned so the discrepancy
    // is never read as a corrupt fixture.
    expect(allRules.split("\n").length - 1).toBe(167);
  });

  test("every entry is a 64-lowercase-hex id, a space, and a file:line:col", () => {
    for (const line of lines(allRules)) {
      const space = line.indexOf(" ");
      expect(space).toBe(64);
      expect(line.slice(0, space)).toMatch(/^[0-9a-f]{64}$/u);
      // Split the location from the RIGHT: one fixture path per PROVENANCE has
      // no colons, but the parser contract does, and the synthetic pair below
      // exercises it.
      expect(line.slice(space + 1)).toMatch(/:\d+:\d+$/u);
    }
  });

  test("covers exactly three source files, all under the sanitized roots", () => {
    const sources = new Set(lines(allRules).map((l) => l.slice(65).replace(/:\d+:\d+$/u, "")));
    expect([...sources].toSorted()).toEqual([
      "/fix/k/include/kframework/builtin/domains.md",
      "/fix/sem/panopticon-semantics.md",
      "/fix/sem/panopticon-syntax.md",
    ]);
  });

  test("125 distinct file:line — the golden's `<line>` count", () => {
    const places = new Set(lines(allRules).map((l) => l.slice(65).replace(/:\d+$/u, "")));
    expect(places.size).toBe(125);
  });

  test("no machine-specific path survived sanitization", () => {
    for (const rel of [
      "cov-build/allRules.txt",
      "cov-build/pid-small_coverage.txt",
      "cov-build/pid-mid_coverage.txt",
      "cov-build/pid-large_coverage.txt",
      "compiled/compiled.json",
      "synthetic/allrules-src.txt",
      "synthetic/allrules-dst.txt",
      "synthetic/golden.cobertura.xml",
    ]) {
      expect(read(rel)).not.toInclude("/nix/store");
      expect(read(rel)).not.toInclude("/home/");
    }
  });

  test(`${MACRO_LOG_NAME} is empty, not missing — the macro-free semantics`, () => {
    expect(read(`cov-build/${MACRO_LOG_NAME}`)).toBe("");
  });

  test.each([
    ["pid-small_coverage.txt", 1, 1],
    ["pid-mid_coverage.txt", 123, 32],
    ["pid-large_coverage.txt", 362, 31],
  ])("%s has %i lines / %i unique ids", (name, total, unique) => {
    const hits = lines(read(`cov-build/${name}`));
    expect(hits).toHaveLength(total);
    expect(new Set(hits).size).toBe(unique);
    for (const id of hits) expect(id).toMatch(/^[0-9a-f]{64}$/u);
    // A log, not a set: `pid-large` applies 31 rules 362 times, which is what
    // makes it the Counter fixture of plan §4 item 1.
    expect(hits.length).toBeGreaterThanOrEqual(new Set(hits).size);
  });

  test("the three logs hit 40 distinct rules, all known to allRules.txt", () => {
    const known = new Set(lines(allRules).map((l) => l.slice(0, 64)));
    const hit = new Set(["small", "mid", "large"].flatMap((s) => lines(read(`cov-build/pid-${s}_coverage.txt`))));
    expect(hit.size).toBe(40);
    for (const id of hit) expect(known.has(id)).toBe(true);
  });

  test("all three hit logs match the glob fs.ts will use", () => {
    const suffix = COVERAGE_LOG_GLOB.slice(1);
    for (const s of ["small", "mid", "large"]) {
      expect(`pid-${s}_coverage.txt`.endsWith(suffix)).toBe(true);
    }
    expect(MACRO_LOG_NAME.endsWith(suffix)).toBe(false);
  });
});

describe("compiled/ — the instrumented definition", () => {
  const definition = readKastDefinitionFromJson(read("compiled/compiled.json"));

  test("is v4 as `kompile` emitted it — no lift was applied", () => {
    // This fixture is direct K 7.1.337 output: the envelope is v4 and every
    // `KSort` carries `params`. Both assertions ensure the fixture is not a
    // transformed v3 artifact. `sanitize-cov-build.py` rejects v3 input.
    const raw = read("compiled/compiled.json");
    expect(raw).toStartWith('{"format":"KAST","version":4,');
    const sorts = [...raw.matchAll(/\{"node":"KSort",(.*?)\}/gu)];
    expect(sorts).toHaveLength(2942);
    for (const sort of sorts) expect(sort[1]).toInclude('"params":');
  });

  test("reads as KAST v4 through @kframework-ts/kast", () => {
    expect(definition.mainModule.name).toBe("PANOPTICON-SEMANTICS");
    // `modules` is the import closure from the main module, not the module
    // list, and `getRuleById` scans that closure — so the count that matters is
    // this one, not `allModules`.
    expect(definition.modules).toHaveLength(11);
  });

  test("holds exactly the 168 rules allRules.txt names, all reachable", () => {
    const named = new Set(lines(read("cov-build/allRules.txt")).map((l) => l.slice(0, 64)));
    const reachable = definition.modules.flatMap((m) => m.sentences.filter((s) => s.node === "KRule"));
    expect(reachable).toHaveLength(168);
    const ids = new Set(reachable.map((r) => r.att.get(Atts.UNIQUE_ID)));
    expect(ids).toEqual(named);
  });

  test("105 rules are <generatedTop>-rooted and 63 are not", () => {
    let generatedTop = 0;
    for (const module of definition.modules) {
      for (const sentence of module.sentences) {
        if (sentence.node !== "KRule") continue;
        const body = sentence.body;
        const head =
          body.node === "KApply"
            ? body.label.name
            : body.node === "KRewrite" && body.lhs.node === "KApply"
              ? body.lhs.label.name
              : "";
        if (head === "<generatedTop>") generatedTop += 1;
      }
    }
    // The population `translateCoverage`'s filter (coverage.py:80-89) splits.
    expect(generatedTop).toBe(105);
  });

  test("every rule carries the arity-2 sideEffect shape, not pyk's stale one", () => {
    // `GenerateCoverage.java:66-78`:
    //   sideEffect:<Sort>(#logToFile(<path>, <uid> + "\n"), <rhs>)
    // pyk's `strip_coverage_logger` (coverage.py:34-43) looks for a `project:`
    // label wrapping a 2-item KSequence instead, and would strip none of these.
    const json = read("compiled/compiled.json");
    const labels = [...json.matchAll(/"name":"(sideEffect:[A-Za-z]+)"/gu)].map((m) => m[1]);
    expect(labels).toHaveLength(168);
    expect(new Set(labels).size).toBe(8);
    expect(new Set(labels)).toContain("sideEffect:GeneratedTopCell");
    expect(json).not.toInclude('"name":"project:');
  });
});

/** The key `translateCoverage` matches on: basename, not full path. */
const basenameKey = (line: string): string => {
  const loc = line.slice(65);
  return loc.slice(loc.lastIndexOf("/") + 1);
};

describe("synthetic/ — the rename-only translate pair", () => {
  const src = lines(read("synthetic/allrules-src.txt"));
  const dst = lines(read("synthetic/allrules-dst.txt"));

  test("same basename:line:col on both sides, different roots and hashes", () => {
    expect(src.map((l) => basenameKey(l))).toEqual(dst.map((l) => basenameKey(l)));
    for (const [i, line] of src.entries()) {
      expect(line.slice(65)).toStartWith("/fix/syn/v1/");
      expect(dst[i]?.slice(65)).toStartWith("/fix/syn/v2/");
      expect(line.slice(0, 64)).not.toBe(dst[i]?.slice(0, 64));
    }
  });

  test("carries the space and colon paths that defeat pyk's own parser", () => {
    const locations = src.map((l) => l.slice(65));
    // coverage.py:66-67 does `line.split(' ')[1]`, which truncates this one.
    expect(locations).toContain("/fix/syn/v1/path with spaces.k:20:3");
    // Splitting the location off from the left mangles this one.
    expect(locations).toContain("/fix/syn/v1/path:with:colons.k:30:7");
  });

  test("all ten ids are distinct 64-hex", () => {
    const ids = [...src, ...dst].map((l) => l.slice(0, 64));
    expect(new Set(ids).size).toBe(10);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe("synthetic/golden.cobertura.xml", () => {
  const golden = read("synthetic/golden.cobertura.xml");

  test("is pinned at timestamp 0, the injected-clock deviation", () => {
    expect(golden).toInclude('timestamp="0"');
    expect(golden).not.toMatch(/timestamp="[1-9]/u);
  });

  test("roots at the common prefix of the three sanitized sources", () => {
    expect(golden).toInclude("<source>/fix</source>");
    for (const name of [
      "k/include/kframework/builtin/domains.md",
      "sem/panopticon-semantics.md",
      "sem/panopticon-syntax.md",
    ]) {
      expect(golden).toInclude(`<class name="${name}" filename="${name}"`);
    }
  });

  test("has one <line> per distinct file:line, 21 of them branch lines", () => {
    expect([...golden.matchAll(/<line number=/gu)]).toHaveLength(125);
    expect([...golden.matchAll(/branch="true"/gu)]).toHaveLength(21);
  });

  test("<line> elements are sorted ascending within each class", () => {
    // Not pyk's own order — pyk emits them in Python set-iteration order, which
    // changes with PYTHONHASHSEED.  The golden is canonicalized, and phase 2's
    // renderer must emit this order.  See fixtures/PROVENANCE.md.
    for (const cls of golden.split("<class ").slice(1)) {
      const numbers = [...cls.matchAll(/<line number="(\d+)"/gu)].map((m) => Number(m[1]));
      expect(numbers).toEqual(numbers.toSorted((a, b) => a - b));
    }
  });

  test("rates are Python repr(float), which JS String(x) must reproduce", () => {
    // 40 of 168 rules covered.  If `String(40 /u 168)` ever stopped agreeing
    // with Python's shortest round-trip repr, the golden would catch it here
    // rather than in phase 2's renderer.
    expect(String(40 / 168)).toBe("0.23809523809523808");
    expect(golden).toInclude('branch-rate="0.23809523809523808"');
    expect(golden).toInclude('line-rate="0.224"');
  });
});

describe("pyk-unit/kore-exec-covr-cases.json — the frozen legacy table", () => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const table = JSON.parse(read("pyk-unit/kore-exec-covr-cases.json")) as {
    parseHaskellOnelineLog: { cases: { id: string; line: string; entry: string; payload: string }[] };
    parseRuleApplications: { cases: { id: string; log: string; expected: Record<string, Record<string, number>> }[] };
  };

  test("carries all 7 upstream cases", () => {
    expect(table.parseHaskellOnelineLog.cases).toHaveLength(5);
    expect(table.parseRuleApplications.cases).toHaveLength(2);
  });

  test("the escaped-space paths survive byte-for-byte", () => {
    const located = table.parseHaskellOnelineLog.cases.find((c) => c.id === "DebugApplyEquation-location");
    // Upstream writes this as a Python raw string: the backslashes are literal.
    expect(located?.payload).toBe(String.raw`/some/path\ with \ spaces/domains.md:1:2-3:4`);
  });

  test("a multi-location line stays ONE composite key", () => {
    const multi = table.parseHaskellOnelineLog.cases.find((c) => c.id === "DebugAppliedRewriteRules-multilocation");
    // Do not "fix" this by splitting on the space — test_kore_exec_covr.py:36-41
    // is the specification and it keeps them joined.
    expect(multi?.payload.split(" -")).toHaveLength(1);
    expect(multi?.payload).toInclude("domains.md:1:2-3:4 /some/other/path");
  });

  test("an empty location normalizes to the literal key UNKNOWN", () => {
    const applications = table.parseRuleApplications.cases.find((c) => c.id === "rewrites-and-simplifications");
    expect(applications?.expected["DebugApplyEquation"]?.["UNKNOWN"]).toBe(1);
    expect(table.parseRuleApplications.cases[0]?.expected).toEqual({
      DebugApplyEquation: {},
      DebugAppliedRewriteRules: {},
    });
  });
});

describe("the transcription manifest", () => {
  test("names six files at one release, in two tiers", () => {
    expect(K_RELEASE).toBe("v7.1.337");
    expect(TRANSCRIBED_FROM).toHaveLength(6);
    expect(TRANSCRIBED_FROM.filter((s) => s.tier === "transcription")).toHaveLength(4);
    expect(TRANSCRIBED_FROM.filter((s) => s.tier === "reference")).toHaveLength(2);
  });

  test("every entry has a 64-hex sha256, a line count and a reason", () => {
    for (const source of TRANSCRIBED_FROM) {
      expect(source.sha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(source.lines).toBeGreaterThan(0);
      expect(source.why.length).toBeGreaterThan(20);
    }
  });

  test("does not duplicate what @kframework-ts/kompiled already pins", () => {
    // `Kompile.java` writes allRules.txt, but this package delegates parsing to
    // kompiled rather than growing a fifth parser (plan §2), so kompiled's
    // manifest is the one place that hash lives.
    expect(TRANSCRIBED_FROM.map((s) => s.path)).not.toContain(
      "k-frontend/src/main/java/org/kframework/kompile/Kompile.java",
    );
  });

  test("io.cpp is recorded outside the manifest and says it is unchecked", () => {
    expect(IO_CPP_IDENTITY.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(IO_CPP_IDENTITY.repo).toBe("runtimeverification/llvm-backend");
    expect(IO_CPP_IDENTITY.checkedBy).toStartWith("nothing");
    expect(TRANSCRIBED_FROM.map((s) => s.path)).not.toContain(IO_CPP_IDENTITY.path);
  });
});
