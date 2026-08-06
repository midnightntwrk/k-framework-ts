/**
 * `fixtures/imp-build/` — the large hit log, and the only test in this package
 * that runs the pipeline at a size a real semantics produces.
 *
 * Everything else here is small on purpose: `cov-build/`'s biggest log is 362
 * lines, the synthetic pair is five entries, and the golden is a 9 KB document.
 * That leaves one class of defect untested — anything that only shows up when
 * the *log* is large rather than the definition: a per-line regex compiled
 * inside the loop, an `Array.includes` where a `Set` belongs, an accidental
 * `O(n²)` merge. `imp-build/pid-large_coverage.txt` is 6 951 lines / 451 815
 * bytes of real `krun` output, which is roughly 19× `cov-build/pid-large` and
 * enough for such a mistake to be visible in wall time rather than in review.
 *
 * The shape of the data matters as much as the size, and it is the *inverse* of
 * `cov-build/`'s: 6 951 applications over **34** distinct rules, a duplication
 * factor of 204. A hit log is a chronological record, not a set
 * (`hits.ts`' module header), and this is the fixture that makes the difference
 * impossible to ignore — `totalHits` and `coverMap.size` differ by two orders
 * of magnitude.
 *
 * `fixtures/PROVENANCE.md`, "The large hit log — `imp-build/`", records how the
 * bytes were made and what was substituted into them. Every count asserted here
 * is quoted from that section, for the reason `fixtures.test.ts` states: a
 * claim in prose that nothing checks is a claim that rots.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { type CoverageDefinition, createRuleMap, renderCoverageReport, renderCoverageXml } from "../src/cobertura.ts";
import { MACRO_LOG_NAME } from "../src/fs.ts";
import { createCoverMap, totalHits } from "../src/hits.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures");
const read = (rel: string): string => readFileSync(join(FIXTURES, `imp-build/${rel}`), "utf8");

/** Split a hit log or an `allRules.txt`: on `\n`, dropping empties. */
const lines = (text: string): string[] => text.split("\n").filter((l) => l !== "");

/** Order `[key, count]` pairs so two maps can be compared without iteration order. */
const byKey = (a: readonly [string, number], b: readonly [string, number]): number =>
  a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;

/** Total of every `hits="…"` attribute in a chunk of Cobertura XML. */
const sumHits = (chunk: string): number =>
  [...chunk.matchAll(/hits="(\d+)"/gu)].reduce((sum, m) => sum + Number(m[1]), 0);

/**
 * The two source files `imp-build/allRules.txt` names, in the order
 * `renderCoverageReport` should emit `<class>` elements for them.
 *
 * The prelude comes first so that this is not the order `coverageSourceRoot`
 * would produce by accident; nothing opens either path (they are sanitized to
 * roots that cannot exist — see `cobertura.test.ts`).
 */
const SOURCES = ["/fix/k/include/kframework/builtin/domains.md", "/fix/imp/imp.k"] as const;

const ALL_RULES = read("allRules.txt");
const HIT_LOG = read("pid-large_coverage.txt");

const impBuild = (): CoverageDefinition => ({
  name: "imp-build",
  allRulesTxt: ALL_RULES,
  coverageLogs: [read(MACRO_LOG_NAME), HIT_LOG],
});

describe("imp-build — the fixture bytes", () => {
  test("allRules.txt has 101 entries over the two sanitized roots, no trailing newline", () => {
    const entries = lines(ALL_RULES);
    expect(entries).toHaveLength(101);
    // `Kompile.java:381` joins with `\n` rather than appending one.
    expect(ALL_RULES.endsWith("\n")).toBe(false);

    const bySource = new Map<string, number>();
    for (const entry of entries) {
      expect(entry.indexOf(" ")).toBe(64);
      expect(entry.slice(0, 64)).toMatch(/^[0-9a-f]{64}$/u);
      const source = entry.slice(65).replace(/:\d+:\d+$/u, "");
      bySource.set(source, (bySource.get(source) ?? 0) + 1);
    }
    expect([...bySource].toSorted(byKey)).toEqual([
      ["/fix/imp/imp.k", 37],
      ["/fix/k/include/kframework/builtin/domains.md", 64],
    ]);
  });

  test("the hit log is 6 951 lines / 34 unique — a duplication factor of 204", () => {
    const hits = lines(HIT_LOG);
    expect(hits).toHaveLength(6951);
    for (const id of hits) expect(id).toMatch(/^[0-9a-f]{64}$/u);

    const unique = new Set(hits);
    expect(unique.size).toBe(34);
    // Unlike `allRules.txt`, the hit log *is* newline-terminated: `io.cpp`
    // writes `"<uid>\n"` per application, so the last line has its own.
    expect(HIT_LOG.endsWith("\n")).toBe(true);
  });

  test("every hit is an id `allRules.txt` knows, and all 34 are IMP's own rules", () => {
    const known = new Map(lines(ALL_RULES).map((l) => [l.slice(0, 64), l.slice(65)]));
    for (const id of new Set(lines(HIT_LOG))) {
      const location = known.get(id);
      expect(location).toBeDefined();
      // No prelude rule ever fires: `+Int`, `/Int` and `<=Int` are LLVM hooks,
      // not rewrite rules, so `domains.md` contributes 64 rules and zero hits.
      // That is what makes the report's two `<class>` elements genuinely
      // different rather than two samples of the same thing.
      expect(location).toStartWith("/fix/imp/imp.k:");
    }
  });

  test(`${MACRO_LOG_NAME} is empty — IMP declares no macro`, () => {
    expect(read(MACRO_LOG_NAME)).toBe("");
  });

  test("no machine-specific path survived sanitization", () => {
    for (const rel of ["allRules.txt", "pid-large_coverage.txt", "loops.imp"]) {
      expect(read(rel)).not.toInclude("/nix/store");
      expect(read(rel)).not.toInclude("/home/");
      expect(read(rel)).not.toInclude("/tmp/");
    }
  });
});

describe("imp-build — the pipeline at scale", () => {
  test("createCoverMap's counts sum to the log's non-blank line count", () => {
    const coverMap = createCoverMap([HIT_LOG]);
    // The distinction the format exists to make: 34 rules, 6 951 applications.
    expect(coverMap.size).toBe(34);
    expect(totalHits(coverMap)).toBe(lines(HIT_LOG).length);
    expect(totalHits(coverMap)).toBe(6951);
  });

  test("the macro log adds nothing — merging an empty text is the identity", () => {
    const alone = createCoverMap([HIT_LOG]);
    const merged = createCoverMap([read(MACRO_LOG_NAME), HIT_LOG]);
    expect([...merged].toSorted(byKey)).toEqual([...alone].toSorted(byKey));
  });

  test("every id resolves in the rule map — no unknownIds", () => {
    const report = renderCoverageReport([impBuild()], SOURCES, { timestamp: 0 });
    expect(report.unknownIds).toEqual([]);
    // `createRuleMap` drops rules whose location did not parse; none did here,
    // so the filtered map still holds all 101.
    expect(report.ruleMap.size).toBe(101);
    expect(report.coverMap.size).toBe(34);
  });

  test("renderCoverageXml emits one `<line>` per distinct source:line in the rule map", () => {
    const ruleMap = createRuleMap([impBuild()], SOURCES);
    const places = new Set([...ruleMap.values()].map((l) => `${l.source}:${l.line}`));
    // Cobertura 1.9 as pyk writes it has no `lines-valid` attribute
    // (`kcovr.py`'s template carries `line-rate` only), so the count of
    // `<line>` elements is the quantity that attribute would hold: one per
    // distinct (source, line), which is `count_lines_global` (`:247-248`).
    expect(places.size).toBe(88);

    const xml = renderCoverageXml([impBuild()], SOURCES, { timestamp: 0 });
    expect(xml.match(/<line number="/gu) ?? []).toHaveLength(places.size);
    expect(xml.match(/<class /gu) ?? []).toHaveLength(2);
    // Rooted where the two sanitized paths diverge.
    expect(xml).toInclude("<source>/fix</source>");
    // Well-formed in the way the phase-2 minting defect was not
    // (PROVENANCE, "A minting defect, found and fixed"): every branch line
    // closes its `<conditions>`.
    expect(xml.match(/<\/class>/gu) ?? []).toHaveLength(2);
    expect(xml.match(/<conditions>/gu) ?? []).toHaveLength((xml.match(/<\/conditions>/gu) ?? []).length);
  });

  test("the covered class carries the applications, the uncovered one carries none", () => {
    const xml = renderCoverageXml([impBuild()], SOURCES, { timestamp: 0 });
    const classes = xml.split("<class ").slice(1);
    expect(classes).toHaveLength(2);

    // `<class>` order follows `sourceFiles` (`kcovr.py:115`), so index 0 is
    // `domains.md` and index 1 is `imp.k`.
    expect(sumHits(classes[0] ?? "")).toBe(0);
    expect(sumHits(classes[1] ?? "")).toBe(6951);
  });

  /**
   * A ceiling, not a benchmark. 1 s is ~200× the time this takes on the machine
   * that made the fixture, which is wide enough that CI noise cannot reach it
   * and narrow enough that an accidentally quadratic merge cannot hide under
   * it.
   */
  test("parsing 6 951 lines and rendering the report stays well under 1 s", () => {
    const started = performance.now();
    const report = renderCoverageReport([impBuild()], SOURCES, { timestamp: 0 });
    const elapsed = performance.now() - started;
    expect(report.xml.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(1000);
  });
});
