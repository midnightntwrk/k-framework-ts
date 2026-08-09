/**
 * The Cobertura renderer — `kcovr.py:16-175,220-260`.
 *
 * The centrepiece is a **differential** test: `renderCoverageXml` over
 * `fixtures/cov-build/` must reproduce `fixtures/synthetic/golden.cobertura.xml`
 * byte-for-byte, and that file was minted by running pyk's own
 * `render_coverage_xml` over the same inputs (`fixtures/PROVENANCE.md`).
 * Passing it means agreeing with the implementation this module transcribes,
 * not restating this module's own output.
 *
 * Everything else here is a case the golden **cannot** reach — PROVENANCE's
 * "What the golden cannot pin" list, plus the deviations from pyk, each named
 * after the behaviour it defends.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  type CoverageDefinition,
  coverageDefinitionSchema,
  coverageSourceRoot,
  createRuleMap,
  formatPythonFloat,
  relativeSourceName,
  renderCoverageReport,
  renderCoverageXml,
} from "../src/cobertura.ts";
import { DuplicateRuleIdError } from "../src/errors.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures");
const read = (rel: string): string => readFileSync(join(FIXTURES, rel), "utf8");

/**
 * The three source files the golden was minted over, in that order.
 *
 * They are path *strings* and nothing opens them, which is not an oversight:
 * `render_coverage_xml` never reads a source file — `count_lines_file`
 * (`kcovr.py:243-244`) counts positions in the rule map — so a report can be
 * produced for a definition whose sources are on another machine.  These
 * `/fix/…` roots are sanitized and exist nowhere.
 */
const GOLDEN_SOURCES = [
  "/fix/k/include/kframework/builtin/domains.md",
  "/fix/sem/panopticon-semantics.md",
  "/fix/sem/panopticon-syntax.md",
];

/** `fixtures/cov-build/` as the pure API sees it, in pyk's file order. */
function covBuild(): CoverageDefinition {
  const dir = join(FIXTURES, "cov-build");
  const logs = readdirSync(dir)
    .filter((name) => name.endsWith("_coverage.txt"))
    .toSorted()
    .map((name) => readFileSync(join(dir, name), "utf8"));
  return {
    name: dir,
    allRulesTxt: read("cov-build/allRules.txt"),
    coverageLogs: [read("cov-build/coverage.txt"), ...logs],
  };
}

describe("coverage definition schema", () => {
  test("accepts the public text transport shape", () => {
    expect(
      coverageDefinitionSchema.parse({
        name: "example-kompiled",
        allRulesTxt: "rule locations",
        coverageLogs: ["first log", "second log"],
      }),
    ).toEqual({
      name: "example-kompiled",
      allRulesTxt: "rule locations",
      coverageLogs: ["first log", "second log"],
    });
  });

  test("rejects malformed artifact text", () => {
    expect(coverageDefinitionSchema.safeParse({ allRulesTxt: "rules", coverageLogs: [1] }).success).toBe(false);
    expect(coverageDefinitionSchema.safeParse({ allRulesTxt: 1, coverageLogs: [] }).success).toBe(false);
  });
});

//////////////////////////////
// The golden               //
//////////////////////////////

describe("the pyk-minted golden", () => {
  test("reproduces the pyk-minted golden byte-for-byte", () => {
    const xml = renderCoverageXml([covBuild()], GOLDEN_SOURCES, { timestamp: 0 });
    expect(xml).toBe(read("synthetic/golden.cobertura.xml"));
  });

  test("is well-formed: every branch line closes its conditions", () => {
    // Phase 1's golden did not, because of a regex in its minting script; the
    // count is asserted so a re-mint can never reintroduce it.  See PROVENANCE,
    // "A minting defect, found and fixed".
    const xml = renderCoverageXml([covBuild()], GOLDEN_SOURCES, { timestamp: 0 });
    expect([...xml.matchAll(/<conditions>/gu)]).toHaveLength(21);
    expect([...xml.matchAll(/<\/conditions>/gu)]).toHaveLength(21);
    expect([...xml.matchAll(/<\/line>/gu)]).toHaveLength(21);
  });

  test("the timestamp is the caller's, never the clock's", () => {
    const xml = renderCoverageXml([covBuild()], GOLDEN_SOURCES, { timestamp: 1_700_000_000 });
    expect(xml).toInclude('timestamp="1700000000"');
  });

  test("reports no unknown ids over a matching build", () => {
    const report = renderCoverageReport([covBuild()], GOLDEN_SOURCES, { timestamp: 0 });
    expect(report.unknownIds).toEqual([]);
    expect(report.ruleMap.size).toBe(168);
    expect(report.coverMap.size).toBe(40);
    expect(report.sourceRoot).toBe("/fix");
  });
});

//////////////////////////////
// Synthetic definitions    //
//////////////////////////////

/** A distinct, well-shaped 64-hex rule id. */
const ruleId = (n: number): string => n.toString(16).padStart(64, "0");

/** Build an `allRules.txt` from `[location, …]`, ids assigned in order. */
function allRulesTxt(locations: readonly string[], offset = 0): string {
  return locations.map((location, i) => `${ruleId(offset + i)} ${location}`).join("\n");
}

/** A hit log naming each id once per repeat. */
function hitLog(ids: readonly number[], repeats = 1): string {
  return ids.flatMap((n) => Array.from({ length: repeats }, () => ruleId(n))).join("\n");
}

describe("branch versus line template", () => {
  // `num_rules_line == 1` (kcovr.py:162) is the whole choice.
  const definition: CoverageDefinition = {
    allRulesTxt: allRulesTxt(["/s/a.k:10:1", "/s/a.k:20:1", "/s/a.k:20:9"]),
    coverageLogs: [hitLog([0, 1], 2)],
  };
  const xml = renderCoverageXml([definition], ["/s/a.k"], { timestamp: 0 });

  test("one rule on a line is a plain line, not a branch", () => {
    expect(xml).toInclude('<line number="10" hits="2" branch="false"/>');
  });

  test("two rules on a line become a branch with conditions", () => {
    expect(xml).toInclude('<line number="20" hits="2" branch="true" condition-coverage="50% (1/2)">');
    expect(xml).toInclude('<condition number="0" type="jump" coverage="50%"/>');
  });

  test("hits on a branch line sum every rule on it", () => {
    const both: CoverageDefinition = { ...definition, coverageLogs: [hitLog([1], 3) + "\n" + hitLog([2], 4)] };
    expect(renderCoverageXml([both], ["/s/a.k"], { timestamp: 0 })).toInclude(
      '<line number="20" hits="7" branch="true" condition-coverage="100% (2/2)">',
    );
  });
});

describe("int(rate * 100) truncation", () => {
  // PROVENANCE, "What the golden cannot pin": every branch line in the real
  // fixture has 2 or 4 rules, so every rate is exact and truncation is
  // invisible.  Three rules on one line is the smallest case that shows it.
  const threeOnOneLine = (covered: readonly number[]): string =>
    renderCoverageXml(
      [
        {
          allRulesTxt: allRulesTxt(["/s/a.k:7:1", "/s/a.k:7:20", "/s/a.k:7:40"]),
          coverageLogs: [hitLog(covered)],
        },
      ],
      ["/s/a.k"],
      { timestamp: 0 },
    );

  test("2 of 3 rules is 66%, not 67% — truncation, not rounding", () => {
    expect(threeOnOneLine([0, 1])).toInclude('condition-coverage="66% (2/3)"');
    expect(threeOnOneLine([0, 1])).toInclude('coverage="66%"');
  });

  test("1 of 3 is 33%", () => {
    expect(threeOnOneLine([2])).toInclude('condition-coverage="33% (1/3)"');
  });

  test("3 of 3 is 100% and 0 of 3 is 0% — the exact ends still work", () => {
    expect(threeOnOneLine([0, 1, 2])).toInclude('condition-coverage="100% (3/3)"');
    expect(threeOnOneLine([])).toInclude('condition-coverage="0% (0/3)"');
  });

  test("the class rates around it are the two different notions of `line`", () => {
    // `count_lines_file` counts distinct (line, column) — three positions — and
    // `count_lines_covered` counts distinct (source, line) — one line.  So the
    // line rate is 1/3 while the rule rate is 2/3, on the same three rules.
    const xml = threeOnOneLine([0, 1]);
    expect(xml).toInclude('line-rate="0.3333333333333333" branch-rate="0.6666666666666666" complexity="3.0"');
  });
});

describe("<line> ordering", () => {
  test("ascending by line number, whatever order allRules.txt is in", () => {
    // pyk's own order follows PYTHONHASHSEED (kcovr.py:179-183 is a `set`).
    const shuffled: CoverageDefinition = {
      allRulesTxt: allRulesTxt(["/s/a.k:30:1", "/s/a.k:5:1", "/s/a.k:200:1", "/s/a.k:20:1"]),
      coverageLogs: [],
    };
    const xml = renderCoverageXml([shuffled], ["/s/a.k"], { timestamp: 0 });
    const numbers = [...xml.matchAll(/<line number="(\d+)"/gu)].map((m) => Number(m[1]));
    expect(numbers).toEqual([5, 20, 30, 200]);
  });
});

describe("zero denominators", () => {
  // `kcovr.py:86,90,125,129` divide unguarded; pyk raises ZeroDivisionError.
  test("a definition with no rules in the requested sources rates 1.0", () => {
    const definition: CoverageDefinition = {
      allRulesTxt: allRulesTxt(["/s/a.k:10:1"]),
      coverageLogs: [],
    };
    const xml = renderCoverageXml([definition], ["/s/nothing-here.k"], { timestamp: 0 });
    expect(xml).toInclude('<coverage line-rate="1.0" branch-rate="1.0" version="1.9" timestamp="0">');
    expect(xml).toInclude('complexity="0.0"');
    // No rules means no classes, which is `:117-118` and not a special case.
    expect(xml).not.toInclude("<class ");
  });

  test("an entirely empty definition rates 1.0 as well", () => {
    const xml = renderCoverageXml([{ allRulesTxt: "", coverageLogs: [] }], [], { timestamp: 0 });
    expect(xml).toInclude('line-rate="1.0" branch-rate="1.0"');
    expect(xml).toInclude("<source>.</source>");
  });

  test("a fully covered file rates 1.0, not JS's 1", () => {
    const definition: CoverageDefinition = {
      allRulesTxt: allRulesTxt(["/s/a.k:1:1"]),
      coverageLogs: [hitLog([0])],
    };
    expect(renderCoverageXml([definition], ["/s/a.k"], { timestamp: 0 })).toInclude(
      '<coverage line-rate="1.0" branch-rate="1.0"',
    );
  });

  test("a wholly uncovered file rates 0.0, not JS's 0", () => {
    const definition: CoverageDefinition = { allRulesTxt: allRulesTxt(["/s/a.k:1:1"]), coverageLogs: [] };
    expect(renderCoverageXml([definition], ["/s/a.k"], { timestamp: 0 })).toInclude(
      '<coverage line-rate="0.0" branch-rate="0.0"',
    );
  });
});

describe("unknown hit ids", () => {
  const definition: CoverageDefinition = {
    allRulesTxt: allRulesTxt(["/s/a.k:1:1", "/s/a.k:2:1"]),
    // One known id, two ids from an older build.
    coverageLogs: [`${ruleId(0)}\n${"f".repeat(64)}\n${"e".repeat(64)}\n${"f".repeat(64)}\n`],
  };
  const report = renderCoverageReport([definition], ["/s/a.k"], { timestamp: 0 });

  test("are collected and sorted rather than raising KeyError", () => {
    // pyk indexes `rule_map[rule_id]` at `:254` and dies.
    expect(report.unknownIds).toEqual(["e".repeat(64), "f".repeat(64)]);
  });

  test("are excluded from every rate", () => {
    // 1 of 2 rules covered — not 3 of 2.
    expect(report.coverMap.size).toBe(1);
    expect(report.xml).toInclude('line-rate="0.5" branch-rate="0.5"');
  });
});

describe("duplicate UNIQUE_ID", () => {
  test("across definition directories, naming the id and both locations", () => {
    const first: CoverageDefinition = { name: "a-kompiled", allRulesTxt: `${ruleId(1)} /s/a.k:1:1`, coverageLogs: [] };
    const second: CoverageDefinition = { name: "b-kompiled", allRulesTxt: `${ruleId(1)} /s/b.k:9:9`, coverageLogs: [] };

    let failure: unknown;
    try {
      createRuleMap([first, second]);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(DuplicateRuleIdError);
    // pyk's `assert len(all_rules) == len(rule_map)` (`:193`) names none of this.
    expect(failure).toMatchObject({
      ruleId: ruleId(1),
      first: "/s/a.k:1:1 (in a-kompiled)",
      second: "/s/b.k:9:9 (in b-kompiled)",
    });
    expect(failure instanceof Error ? failure.message : "").toInclude(ruleId(1));
  });

  test("within one allRules.txt, which pyk's assert also catches", () => {
    // `parseAllRules` is keyed by id and would silently keep the last; the size
    // of pyk's line `set` (`:193`) is what detects it.
    const clashing: CoverageDefinition = {
      allRulesTxt: `${ruleId(1)} /s/a.k:1:1\n${ruleId(1)} /s/a.k:2:2`,
      coverageLogs: [],
    };
    expect(() => createRuleMap([clashing])).toThrow(/Duplicate UNIQUE_ID/u);
  });

  test("the same line twice is not a duplicate — pyk's set collapses it too", () => {
    const repeated: CoverageDefinition = {
      allRulesTxt: `${ruleId(1)} /s/a.k:1:1\n${ruleId(1)} /s/a.k:1:1`,
      coverageLogs: [],
    };
    expect(createRuleMap([repeated]).size).toBe(1);
    // And so is the same directory listed twice.
    expect(createRuleMap([repeated, repeated]).size).toBe(1);
  });

  test("is checked before the source filter, so a scoped report still sees it", () => {
    const first: CoverageDefinition = { allRulesTxt: `${ruleId(1)} /s/x.k:1:1`, coverageLogs: [] };
    const second: CoverageDefinition = { allRulesTxt: `${ruleId(1)} /s/y.k:1:1`, coverageLogs: [] };
    expect(() => createRuleMap([first, second], ["/s/unrelated.k"])).toThrow(DuplicateRuleIdError);
  });
});

describe("rule-map filtering", () => {
  const definition: CoverageDefinition = {
    allRulesTxt: [
      `${ruleId(0)} /s/a.k:1:1`,
      `${ruleId(1)} /s/b.k:1:1`,
      // No `:line:col` at all — `parseAllRules` keeps it with NaN positions.
      `${ruleId(2)} /s/nowhere`,
    ].join("\n"),
    coverageLogs: [],
  };

  test("keeps everything when no sources are given — what `kcovr hits` needs", () => {
    // Except the unplaceable one: a rule with no line cannot go in a document.
    expect([...createRuleMap([definition]).keys()]).toEqual([ruleId(0), ruleId(1)]);
  });

  test("drops rules whose source was not requested", () => {
    expect([...createRuleMap([definition], ["/s/a.k"]).keys()]).toEqual([ruleId(0)]);
  });

  test("the global complexity counts only the requested sources", () => {
    // pyk's `len(rule_map)` (`:85`) counts every rule in every file, so its
    // scoped reports carry unscoped totals.  Deviation 6.
    const xml = renderCoverageXml([definition], ["/s/a.k"], { timestamp: 0 });
    expect(xml).toInclude('complexity="1.0"');
  });

  test("classes follow the source-file order, and empty sources are skipped", () => {
    const xml = renderCoverageXml([definition], ["/s/b.k", "/s/missing.k", "/s/a.k"], { timestamp: 0 });
    const names = [...xml.matchAll(/<class name="([^"]+)"/gu)].map((m) => m[1]);
    expect(names).toEqual(["b.k", "a.k"]);
  });
});

//////////////////////////////
// Source roots             //
//////////////////////////////

describe("coverageSourceRoot", () => {
  test("prefix-is-directory: the common prefix already ends at a separator", () => {
    // The golden's own shape, and the one case pyk survives.
    expect(coverageSourceRoot(["/fix/k/include/x.md", "/fix/sem/y.md", "/fix/sem/z.md"])).toBe("/fix");
    expect(coverageSourceRoot(["/a/b/x.md", "/a/b/y.md"])).toBe("/a/b");
  });

  test("prefix-ends-mid-component: what makes pyk raise ValueError", () => {
    // `commonprefix` is a character prefix: `/pfx/foo`, which is not a
    // directory, and `Path.relative_to` then refuses.  `bin/kcovr:82` truncates.
    expect(coverageSourceRoot(["/pfx/foo.md", "/pfx/foobar.md"])).toBe("/pfx");
    expect(relativeSourceName("/pfx", "/pfx/foo.md")).toBe("foo.md");
    expect(relativeSourceName("/pfx", "/pfx/foobar.md")).toBe("foobar.md");
  });

  test("single-source: the file's own name, where pyk emits `.`", () => {
    // `p.relative_to(p)` is `.`, so `pyk-covr` over one source renders
    // `<class name="." filename=".">`.
    expect(coverageSourceRoot(["/a/b/only.md"])).toBe("/a/b");
    expect(relativeSourceName("/a/b", "/a/b/only.md")).toBe("only.md");
  });

  test("root-level sources root at `/`", () => {
    expect(coverageSourceRoot(["/a.md", "/b.md"])).toBe("/");
    expect(coverageSourceRoot(["/sem/a.md", "/semantics/b.md"])).toBe("/");
    expect(relativeSourceName("/", "/sem/a.md")).toBe("sem/a.md");
  });

  test("no separator at all, and no sources at all, are both `.`", () => {
    expect(coverageSourceRoot(["foo.md", "fob.md"])).toBe(".");
    expect(coverageSourceRoot([])).toBe(".");
    expect(relativeSourceName(".", "foo.md")).toBe("foo.md");
  });

  test("a path outside the root keeps its whole name rather than throwing", () => {
    expect(relativeSourceName("/a/b", "/elsewhere/c.md")).toBe("/elsewhere/c.md");
  });

  test("the single-source root reaches the document", () => {
    const definition: CoverageDefinition = { allRulesTxt: `${ruleId(0)} /a/b/only.md:3:1`, coverageLogs: [] };
    const xml = renderCoverageXml([definition], ["/a/b/only.md"], { timestamp: 0 });
    expect(xml).toInclude("<source>/a/b</source>");
    expect(xml).toInclude('<class name="only.md" filename="only.md"');
  });
});

//////////////////////////////
// Float formatting         //
//////////////////////////////

describe("formatPythonFloat", () => {
  test("matches Python repr on every rate in the golden", () => {
    for (const value of [
      "0.224",
      "0.23809523809523808",
      "0.015873015873015872",
      "0.4634146341463415",
      "0.38095238095238093",
      "0.3125",
    ]) {
      expect(formatPythonFloat(Number(value))).toBe(value);
    }
    // Computed, not merely round-tripped: these are the actual divisions.
    expect(formatPythonFloat(40 / 168)).toBe("0.23809523809523808");
    expect(formatPythonFloat(28 / 125)).toBe("0.224");
    expect(formatPythonFloat(1 / 63)).toBe("0.015873015873015872");
  });

  test("integral values keep Python's `.0`, which `String(x)` drops", () => {
    expect(formatPythonFloat(1)).toBe("1.0");
    expect(formatPythonFloat(0)).toBe("0.0");
    expect(formatPythonFloat(3 / 3)).toBe("1.0");
    expect(String(1)).toBe("1"); // the trap this exists to avoid
  });

  test("goes exponential below 1e-4, where JS waits until 1e-6", () => {
    // 1 rule covered out of 20 000 — KEVM-scale, and the reason this is not
    // "String(x) is fine because the golden says so".
    expect(formatPythonFloat(1 / 20_000)).toBe("5e-05");
    expect(String(1 / 20_000)).toBe("0.00005");
    expect(formatPythonFloat(1e-7)).toBe("1e-07");
    expect(formatPythonFloat(0.000123456789)).toBe("0.000123456789");
    expect(formatPythonFloat(0.0001)).toBe("0.0001");
    expect(formatPythonFloat(9.999999999999999e-5)).toBe("9.999999999999999e-05");
  });

  test("goes exponential at 1e16, where JS waits until 1e21", () => {
    // Unreachable from a rate, which is why it is asserted rather than assumed.
    expect(formatPythonFloat(1e16)).toBe("1e+16");
    expect(formatPythonFloat(1e15)).toBe("1000000000000000.0");
  });

  test("names the non-finite values the way Python does", () => {
    expect(formatPythonFloat(Number.NaN)).toBe("nan");
    expect(formatPythonFloat(Number.POSITIVE_INFINITY)).toBe("inf");
    expect(formatPythonFloat(-0)).toBe("-0.0");
  });
});
