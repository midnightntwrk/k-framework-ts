/**
 * The Cobertura 1.9 renderer — `kcovr.py:16-49` (the templates) and
 * `:76-175,220-260` (the arithmetic), transcribed.
 *
 * Cobertura's schema has no notion of a rewrite rule, so `kcovr.py` borrows the
 * one it does have: a source **line** carrying more than one rule is reported
 * as a *branch* line whose conditions are its rules, and `complexity` carries
 * the rule count.  That mapping is the whole design, and it is why the two
 * `<line>` templates differ only by `num_rules_line == 1` (`:162`).  Consumers
 * — Jenkins, Codecov, `pycobertura` — then show "branch coverage" and mean
 * "rule coverage".
 *
 * ## What "transcribed" means here
 *
 * The four templates below are **byte-for-byte** copies of pyk's, leading and
 * trailing newlines included: the blank lines they produce between elements are
 * a property of the output, and `fixtures/synthetic/golden.cobertura.xml` —
 * minted from pyk's own renderer, see `fixtures/PROVENANCE.md` — is the test
 * that they still are.  Every rate is computed with the same numerator and
 * denominator as upstream, including the two places where upstream's choice is
 * arguably a bug and is kept anyway:
 *
 * - `count_lines_file` (`:243-244`) counts distinct **(line, column)** pairs,
 *   while `count_lines_covered` (`:251-256`) counts distinct **(source, line)**
 *   pairs.  So a `<class>`'s `line-rate` divides a count of lines by a count of
 *   *positions*, and two rules on one line at different columns make the
 *   denominator larger than the number of `<line>` elements emitted.  It is
 *   reproduced exactly; changing it would silently change every published
 *   number.
 * - `render_classes` (`:127`) passes the **global** rule map to
 *   `count_lines_covered` together with a per-file cover map.  Same cardinality
 *   either way, and kept as written.
 *
 * ## Deliberate deviations, each tested by name
 *
 * 1. **`<line>` elements are emitted in ascending line-number order.**  pyk
 *    accumulates `allRules.txt` into a Python `set[str]` (`:179-183`), so its
 *    element order follows `PYTHONHASHSEED` and its XML is **not reproducible
 *    run to run** — phase 1 measured three sha256s from three unseeded runs of
 *    the same inputs.  Sorting is lossless (there is exactly one `<line>` per
 *    line number in a class, `:231-240`) and total, and it is the only choice
 *    that makes a golden test possible.  This is a strengthening of pyk, not a
 *    match of it.
 * 2. **The source root is the common prefix truncated to the last `/`.**
 *    `kcovr.py:79` uses `os.path.commonprefix` bare, which is a *character*
 *    prefix, and then `Path.relative_to` (`:134`), which requires a *path*
 *    prefix.  Give it `foo.md` and `foobar.md` in one directory and it raises
 *    `ValueError: '…/pfx/foo.md' is not in the subpath of '…/pfx/foo'` — phase 1
 *    reproduced this.  Truncating at the component boundary is what
 *    `bin/kcovr:82` does (`dirname(commonprefix(...))`), is byte-identical to
 *    pyk in every case where pyk survives (verified against the golden), and
 *    turns a crash into an answer.  See {@link coverageSourceRoot}.
 * 3. **Zero denominators render as `1.0`.**  `:86,90,125,129` divide unguarded,
 *    so pyk raises `ZeroDivisionError` on a definition with no rules in the
 *    requested sources — a state a real `--coverage` build reaches whenever a
 *    report is scoped to a source file that happens to contain no rules.
 *    Nothing to cover means everything is covered.
 * 4. **Unknown hit ids are a diagnostic, not a crash.**  `:253-255` indexes the
 *    rule map with every id in the cover map, so one stale id — the ordinary
 *    result of recompiling between the run and the report, since hit logs are
 *    append-only — kills the whole report with a `KeyError`.  They are
 *    collected into {@link CoverageReport.unknownIds} and excluded from the
 *    rates instead.
 * 5. **The timestamp is injected.**  `:92` calls `time.time()`.  Here it is a
 *    required option, which is what makes the golden byte-exact; only `bin.ts`
 *    reads a clock.
 * 6. **Rule-map entries are filtered to the requested sources** (plan §4 item
 *    5).  pyk filters only the `<class>` list (`:117-118`) while its global
 *    `complexity`, `line-rate` and `branch-rate` keep counting rules in files
 *    the caller did not ask about, so a scoped report reports unscoped totals.
 *    Byte-identical whenever every source is requested, which is the normal
 *    case and the golden's case.
 * 7. **No `os.path.abspath`.**  `:191` absolutizes each `allRules.txt` path
 *    against the *current working directory*, which would make this module's
 *    output depend on where the process was started.  Paths are compared as
 *    written; `cli.ts` resolves the caller's source arguments before handing
 *    them over, which is the same normalization pyk's `parse_args` does at
 *    `:70-71`.
 *
 * One upstream hazard is **not** fixed: nothing is XML-escaped, exactly as
 * upstream escapes nothing.  A source path containing `&` or `<` produces a
 * malformed document in both implementations.  Escaping it would be a silent
 * byte-level divergence from the format consumers have been fed for a decade,
 * so it is reported here rather than papered over.
 *
 * ## No fifth `allRules.txt` parser
 *
 * `create_rule_map` (`:178-194`) is pyk's own — and it is the *third* of four
 * mutually inconsistent parsers in that codebase.  This package adds none:
 * {@link createRuleMap} routes every line through
 * `@kframework-ts/kompiled`'s `parseAllRules`, which splits the location from
 * the right (so `/nix/store/…` and `C:\…` paths survive) and is pinned by that
 * package's own drift manifest.
 */

import { parseAllRules, type RuleLocation } from "@kframework-ts/kompiled/core";

import { DuplicateRuleIdError } from "./errors.js";
import { createCoverMap, type CoverMap, type RuleId } from "./hits.js";

//////////////////////////////
// Templates                //
//////////////////////////////

/*
 * Byte-for-byte from `kcovr.py:16-49`.  Each is a Python triple-quoted string
 * that opens with a newline and closes with one, and both are load-bearing: the
 * blank line between two `<line>` elements in real Cobertura output from `pyk`
 * is the trailing newline of one template meeting the leading newline of the
 * next.  Do not reflow, re-indent, or "tidy" these — `oxfmt` leaves template
 * literals alone, and the golden test fails the moment a byte moves.
 */

/** `kcovr.py:16-29`. */
const TEMPLATE = `
<coverage line-rate="{line_rate}" branch-rate="{rule_rate}" version="1.9" timestamp="{timestamp}">
  <sources>
    <source>{source_dir}</source>
  </sources>
  <packages>
    <package name="" line-rate="{line_rate}" branch-rate="{rule_rate}" complexity="{num_rules}.0">
      <classes>
        {classes_elem}
      </classes>
    </package>
  </packages>
</coverage>
`;

/** `kcovr.py:31-37`. */
const CLASS_TEMPLATE = `
<class name="{filename}" filename="{filename}" line-rate="{line_rate}" branch-rate="{rule_rate}" complexity="{num_rules}.0">
  <lines>
    {lines_elem}
  </lines>
</class>
`;

/** `kcovr.py:39-41` — the `num_rules_line == 1` case. */
const LINE_TEMPLATE_NO_BRANCH = `
<line number="{line_num}" hits="{hits}" branch="false"/>
`;

/** `kcovr.py:43-49` — two or more rules on one source line. */
const LINE_TEMPLATE_BRANCH = `
<line number="{line_num}" hits="{hits}" branch="true" condition-coverage="{rule_rate}% ({rules_covered}/{num_rules})">
  <conditions>
    <condition number="0" type="jump" coverage="{rule_rate}%"/>
  </conditions>
</line>
`;

/**
 * `str.format` for the four templates above.
 *
 * A replacement is never rescanned — `String.replace` does not re-examine what
 * a callback returns — so a filename containing `{line_rate}` cannot inject a
 * value, which is more than Python's `str.format` guarantees.
 */
function format(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replaceAll(/\{(\w+)\}/gu, (whole, key: string) => {
    const value = values[key];
    return value === undefined ? whole : String(value);
  });
}

//////////////////////////////
// Python float formatting  //
//////////////////////////////

/**
 * Format a number the way Python's `repr(float)` does — the format
 * `'{line_rate}'.format(0.224)` produces, and therefore the format every
 * `line-rate` and `branch-rate` in the output must be in.
 *
 * Both languages print the **shortest decimal string that round-trips**, so for
 * most values `String(x)` is already right, and phase 1 confirmed it on every
 * rate in the golden.  Three cases differ, and rates reach two of them:
 *
 * | value              | JS `String`     | Python `repr` | reachable?                                |
 * | ------------------ | --------------- | ------------- | ----------------------------------------- |
 * | `1`, `0`           | `1`, `0`        | `1.0`, `0.0`  | **yes** — a fully covered or wholly uncovered file, and the zero-denominator deviation |
 * | `5e-5`             | `0.00005`       | `5e-05`       | **yes** — 1 rule covered out of 20 000, which KEVM-scale semantics reach |
 * | `1e16`             | `10000000000000000` | `1e+16`   | no — every rate is in `[0, 1]`            |
 *
 * CPython's rule is `format_float_short` with mode `'r'`: exponential notation
 * when the decimal point position `decpt` satisfies `decpt <= -4 || decpt > 16`
 * — i.e. below `1e-4` or at/above `1e16` — with the exponent signed and padded
 * to two digits, and a `.0` appended to anything that would otherwise look like
 * an integer.  JavaScript switches to exponential only below `1e-6` and at/above
 * `1e21`, and never appends `.0`.  That is the entire delta, and it is what this
 * function applies.
 */
export function formatPythonFloat(value: number): string {
  if (Number.isNaN(value)) return "nan";
  if (value === Number.POSITIVE_INFINITY) return "inf";
  if (value === Number.NEGATIVE_INFINITY) return "-inf";
  // `String(-0)` is `"0"`; Python keeps the sign.  Unreachable from a rate, but
  // a function that claims to be `repr` should not lie about it.
  if (value === 0) return Object.is(value, -0) ? "-0.0" : "0.0";

  const magnitude = Math.abs(value);
  if (magnitude < 1e-4 || magnitude >= 1e16) {
    // `toExponential()` with no argument is specified to use "as many digits as
    // necessary to uniquely specify the number" — the same shortest-round-trip
    // digits `String` uses, just always in exponential form.
    const text = value.toExponential();
    const e = text.indexOf("e");
    const exponent = Number(text.slice(e + 1));
    return `${text.slice(0, e)}e${exponent < 0 ? "-" : "+"}${String(Math.abs(exponent)).padStart(2, "0")}`;
  }
  const shortest = String(value);
  return Number.isInteger(value) ? `${shortest}.0` : shortest;
}

/**
 * A rate, with the zero denominator pyk leaves unguarded (`kcovr.py:86,90,125,129`).
 *
 * Nothing to cover means everything is covered: `1.0`, not a `ZeroDivisionError`.
 */
function rate(covered: number, total: number): number {
  return total === 0 ? 1 : covered / total;
}

//////////////////////////////
// Source roots             //
//////////////////////////////

/**
 * The directory every `filename` in the report is relative to, and the single
 * `<source>` element's text.
 *
 * pyk computes `Path(os.path.commonprefix([str(p) for p in source_files]))`
 * (`kcovr.py:79`).  `commonprefix` is a **character** prefix — for
 * `/pfx/foo.md` and `/pfx/foobar.md` it is `/pfx/foo`, which is not a directory
 * — and `Path.relative_to` (`:134`) then raises `ValueError`.  Truncating the
 * prefix at its last `/` is `bin/kcovr:82`'s `dirname(commonprefix(...))`, and
 * it agrees with pyk byte-for-byte wherever pyk does not crash, because
 * `Path("/fix/")` and `"/fix"` are the same path.
 *
 * Three shapes, all tested:
 *
 * | sources                                    | prefix      | root    | filenames             |
 * | ------------------------------------------ | ----------- | ------- | --------------------- |
 * | `/fix/sem/a.md`, `/fix/k/b.md`             | `/fix/`     | `/fix`  | `sem/a.md`, `k/b.md`  |
 * | `/pfx/foo.md`, `/pfx/foobar.md`            | `/pfx/foo`  | `/pfx`  | `foo.md`, `foobar.md` |
 * | `/a/b/only.md`                             | `/a/b/only.md` | `/a/b` | `only.md`            |
 *
 * The single-source row is a third divergence from pyk and the reason the
 * truncation is not merely a crash fix: pyk's prefix of one path is that path,
 * and `p.relative_to(p)` is `.`, so `pyk-covr` over one source file emits
 * `<class name="." filename=".">`.  `bin/kcovr` and this function emit the
 * file's own name.
 *
 * With no sources at all the root is `"."`, matching `Path("")`; the report has
 * no classes in that case anyway.
 */
export function coverageSourceRoot(sourceFiles: Iterable<string>): string {
  const paths = [...sourceFiles];
  const first = paths[0];
  if (first === undefined) return ".";

  let prefix = first;
  for (const path of paths) {
    let i = 0;
    while (i < prefix.length && i < path.length && prefix[i] === path[i]) i += 1;
    prefix = prefix.slice(0, i);
  }

  const lastSlash = prefix.lastIndexOf("/");
  // No separator at all means the sources are bare names in the working
  // directory; `Path("")` is `.`, and the names are already relative to it.
  if (lastSlash === -1) return ".";
  // The prefix is inside the root directory itself: `dirname("/sem")` is `/`.
  if (lastSlash === 0) return "/";
  return prefix.slice(0, lastSlash);
}

/**
 * A source path as it appears in `<class filename=…>` — the counterpart of
 * `Path.relative_to(source_dir)` (`kcovr.py:134`).
 *
 * A path that is not under the root is returned unchanged rather than raising,
 * because {@link coverageSourceRoot} guarantees the containment for the sources
 * it was derived from and a caller passing an unrelated path is better served
 * by a report naming the file than by an exception.
 */
export function relativeSourceName(sourceRoot: string, sourceFile: string): string {
  if (sourceRoot === ".") return sourceFile;
  if (sourceRoot === "/") return sourceFile.startsWith("/") ? sourceFile.slice(1) : sourceFile;
  return sourceFile.startsWith(`${sourceRoot}/`) ? sourceFile.slice(sourceRoot.length + 1) : sourceFile;
}

//////////////////////////////
// Rule maps                //
//////////////////////////////

/**
 * One definition directory's coverage artifacts, as **text** — the pure-API
 * stand-in for the `Path` pyk passes around (`kcovr.py:76`).
 *
 * `fs.ts` builds one of these per directory; a test, a zip reader or an HTTP
 * client can build one from anything.
 */
export interface CoverageDefinition {
  /**
   * What to call this definition in an error message — normally the directory
   * it was read from.  Purely diagnostic; nothing keys on it.
   */
  readonly name?: string;
  /** The contents of `allRules.txt` (`Kompile.java:363-382`). */
  readonly allRulesTxt: string;
  /**
   * Every hit log to count, in pyk's order: `coverage.txt` first, then each
   * `*_coverage.txt` (`kcovr.py:205-215`).  Order does not affect the result.
   */
  readonly coverageLogs: readonly string[];
}

/**
 * Where each rule lives — `rule_map` (`kcovr.py:178-194`), keyed by the full
 * 64-hex `UNIQUE_ID`.
 *
 * The value is `@kframework-ts/kompiled`'s {@link RuleLocation}, so `source`,
 * `line` and `column` come from the parser that already owns this format
 * rather than from a fourth reimplementation of it.
 */
export type RuleMap = ReadonlyMap<RuleId, RuleLocation>;

/**
 * Merge every definition's `allRules.txt` into one rule map
 * (`kcovr.py:178-194`).
 *
 * Two entries are dropped, and both drops are plan §4 item 5:
 *
 * - **unparsed locations** — `parseAllRules` reports these as `NaN` line and
 *   column rather than losing the rule, but a rule with no line cannot be
 *   placed in a Cobertura document;
 * - **sources the caller did not ask about**, when `sourceFiles` is given.
 *   Omit it — as `kcovr hits` does — to keep every rule.
 *
 * Duplicate ids are checked **before** either drop, exactly where pyk's assert
 * sits (`:193`), so a mismatched pair of definition directories is reported
 * even when the conflicting rule is outside the requested sources.
 *
 * @throws {DuplicateRuleIdError} one `UNIQUE_ID`, two different locations.
 */
export function createRuleMap(definitions: Iterable<CoverageDefinition>, sourceFiles?: Iterable<string>): RuleMap {
  const merged = new Map<RuleId, RuleLocation>();
  const origin = new Map<RuleId, string>();

  for (const definition of definitions) {
    const where = definition.name === undefined ? "" : ` (in ${definition.name})`;
    const parsed = parseAllRules(definition.allRulesTxt);
    const { allRules } = parsed;

    // The shared parser keeps all rows for a complete audit, while the public
    // maps intentionally retain pyk's last-write-wins compatibility. Keep this
    // report builder's historical contract: byte-identical repeated rows are
    // pyk-set-compatible; different locations for one id are contradictory.
    for (const duplicate of parsed.duplicateRuleIds) {
      const first = duplicate.locations[0];
      const conflicting = duplicate.locations.find((location) => location.location !== first?.location);
      if (first !== undefined && conflicting !== undefined) {
        throw new DuplicateRuleIdError(
          duplicate.ruleId,
          `${first.location}${where}`,
          `${conflicting.location}${where}`,
        );
      }
    }

    for (const [ruleId, location] of allRules) {
      const seen = merged.get(ruleId);
      if (seen !== undefined && seen.location !== location.location) {
        throw new DuplicateRuleIdError(
          ruleId,
          `${seen.location}${origin.get(ruleId) ?? ""}`,
          `${location.location}${where}`,
        );
      }
      merged.set(ruleId, location);
      origin.set(ruleId, where);
    }
  }

  const wanted = sourceFiles === undefined ? undefined : new Set(sourceFiles);
  const ruleMap = new Map<RuleId, RuleLocation>();
  for (const [ruleId, location] of merged) {
    if (!Number.isInteger(location.line) || !Number.isInteger(location.column)) continue;
    if (wanted !== undefined && !wanted.has(location.source)) continue;
    ruleMap.set(ruleId, location);
  }
  return ruleMap;
}

//////////////////////////////
// Counting                 //
//////////////////////////////

/** `count_lines_file` (`kcovr.py:243-244`) — distinct **(line, column)** pairs. */
function countLinesFile(ruleMapFile: ReadonlyMap<RuleId, RuleLocation>): number {
  const places = new Set<string>();
  for (const location of ruleMapFile.values()) places.add(`${location.line}:${location.column}`);
  return places.size;
}

/** `count_lines_global` (`kcovr.py:247-248`) — distinct **(source, line)** pairs. */
function countLinesGlobal(ruleMap: RuleMap): number {
  const places = new Set<string>();
  for (const location of ruleMap.values()) places.add(`${location.source}:${location.line}`);
  return places.size;
}

/**
 * `count_lines_covered` (`kcovr.py:251-256`) — distinct (source, line) pairs
 * among the rules that ran.
 *
 * pyk indexes `rule_map[rule_id]` unguarded; an id the rule map does not know
 * is skipped here, because {@link renderCoverageReport} has already collected
 * it into `unknownIds` and reporting it twice as a crash helps nobody.
 */
function countLinesCovered(ruleMap: RuleMap, coverMap: CoverMap): number {
  const places = new Set<string>();
  for (const ruleId of coverMap.keys()) {
    const location = ruleMap.get(ruleId);
    if (location !== undefined) places.add(`${location.source}:${location.line}`);
  }
  return places.size;
}

//////////////////////////////
// Rendering                //
//////////////////////////////

/** Everything {@link renderCoverageReport} knows, not only the bytes. */
export interface CoverageReport {
  /** The Cobertura 1.9 document — what `pyk-covr` prints. */
  readonly xml: string;
  /**
   * Hit-log ids with no entry in any `allRules.txt`, sorted.
   *
   * Almost always the sign of a stale log: hit files are opened in append mode
   * and flushed at exit (`io.cpp:552,566`), so a recompile between the run and
   * the report leaves ids from the previous build in the file.  They are
   * excluded from every rate — counting them would inflate the numerator
   * against a denominator that cannot contain them — and `kcovr report` warns
   * on stderr when this is non-empty.  pyk raises `KeyError` instead
   * (`kcovr.py:253-255`).
   */
  readonly unknownIds: readonly RuleId[];
  /** The `<source>` element's text, from {@link coverageSourceRoot}. */
  readonly sourceRoot: string;
  /** The merged rule map the report was computed from, after both filters. */
  readonly ruleMap: RuleMap;
  /** Applications per rule, with {@link CoverageReport.unknownIds} removed. */
  readonly coverMap: CoverMap;
}

/** The one option, and it is required — see deviation 5 in the module header. */
export interface CoverageOptions {
  /**
   * The document's `timestamp` attribute, in **seconds** since the epoch —
   * `int(time.time())` (`kcovr.py:92`).  Required rather than defaulted so that
   * two runs over the same inputs produce the same bytes; `bin.ts` supplies
   * `Math.floor(Date.now() / 1000)`.
   */
  readonly timestamp: number;
}

/**
 * Render a Cobertura 1.9 report, and say what was odd about the inputs —
 * `render_coverage_xml` (`kcovr.py:76-103`) plus the two diagnostics pyk
 * answers with exceptions.
 *
 * `sourceFiles` is both the filter and the `<class>` order: classes are emitted
 * in the order given (`:115`), and a source with no rules in it is skipped
 * (`:117-118`).  Pass the paths as they appear in `allRules.txt` — absolute, in
 * every real build — because they are compared as written (deviation 7).
 */
export function renderCoverageReport(
  definitions: Iterable<CoverageDefinition>,
  sourceFiles: Iterable<string>,
  options: CoverageOptions,
): CoverageReport {
  const definitionList = [...definitions];
  const sources = [...sourceFiles];

  const ruleMap = createRuleMap(definitionList, sources);
  const allHits = createCoverMap(definitionList.flatMap((definition) => definition.coverageLogs));

  const stale: RuleId[] = [];
  const coverMap = new Map<RuleId, number>();
  for (const [ruleId, count] of allHits) {
    if (ruleMap.has(ruleId)) coverMap.set(ruleId, count);
    else stale.push(ruleId);
  }
  const unknownIds = stale.toSorted();

  const sourceRoot = coverageSourceRoot(sources);
  const classesElem = renderClasses(ruleMap, coverMap, sources, sourceRoot).join("");

  // `:84-90`, with `rate` supplying the zero-denominator answer pyk crashes on.
  const ruleRateGlobal = rate(coverMap.size, ruleMap.size);
  const lineRateGlobal = rate(countLinesCovered(ruleMap, coverMap), countLinesGlobal(ruleMap));

  const xml = format(TEMPLATE, {
    line_rate: formatPythonFloat(lineRateGlobal),
    rule_rate: formatPythonFloat(ruleRateGlobal),
    timestamp: options.timestamp,
    num_rules: ruleMap.size,
    source_dir: sourceRoot,
    classes_elem: classesElem,
  });

  return { xml, unknownIds, sourceRoot, ruleMap, coverMap };
}

/**
 * The Cobertura 1.9 document alone — `render_coverage_xml`'s own return type
 * (`kcovr.py:76`).
 *
 * Use {@link renderCoverageReport} when the `unknownIds` diagnostic matters.
 */
export function renderCoverageXml(
  definitions: Iterable<CoverageDefinition>,
  sourceFiles: Iterable<string>,
  options: CoverageOptions,
): string {
  return renderCoverageReport(definitions, sourceFiles, options).xml;
}

/** `render_classes` (`kcovr.py:106-146`). */
function renderClasses(
  ruleMap: RuleMap,
  coverMap: CoverMap,
  sourceFiles: readonly string[],
  sourceRoot: string,
): string[] {
  const byFile = new Map<string, Map<RuleId, RuleLocation>>();
  for (const [ruleId, location] of ruleMap) {
    let file = byFile.get(location.source);
    if (file === undefined) {
      file = new Map();
      byFile.set(location.source, file);
    }
    file.set(ruleId, location);
  }

  const classes: string[] = [];
  for (const sourceFile of sourceFiles) {
    const ruleMapFile = byFile.get(sourceFile);
    // `:117-118` — a source with no rules gets no `<class>` at all.
    if (ruleMapFile === undefined) continue;

    const coverMapFile = new Map<RuleId, number>();
    for (const [ruleId, count] of coverMap) {
      if (ruleMapFile.has(ruleId)) coverMapFile.set(ruleId, count);
    }

    const ruleRateFile = rate(coverMapFile.size, ruleMapFile.size);
    // Note the two different notions of "line" — see the module header.
    const lineRateFile = rate(countLinesCovered(ruleMap, coverMapFile), countLinesFile(ruleMapFile));

    classes.push(
      format(CLASS_TEMPLATE, {
        filename: relativeSourceName(sourceRoot, sourceFile),
        line_rate: formatPythonFloat(lineRateFile),
        rule_rate: formatPythonFloat(ruleRateFile),
        num_rules: ruleMapFile.size,
        lines_elem: renderLines(ruleMapFile, coverMapFile).join(""),
      }),
    );
  }

  return classes;
}

/** `render_lines` (`kcovr.py:149-175`), emitted in ascending line order. */
function renderLines(ruleMapFile: ReadonlyMap<RuleId, RuleLocation>, coverMapFile: CoverMap): string[] {
  const byLine = new Map<number, RuleId[]>();
  for (const [ruleId, location] of ruleMapFile) {
    const rules = byLine.get(location.line);
    if (rules === undefined) byLine.set(location.line, [ruleId]);
    else rules.push(ruleId);
  }

  const lines: string[] = [];
  // Deviation 1: pyk emits in `set` iteration order, which is seeded per
  // process.  Ascending is the only reproducible total order, and it is the one
  // the golden was minted in.
  for (const lineNum of [...byLine.keys()].toSorted((a, b) => a - b)) {
    const rules = byLine.get(lineNum) ?? [];
    let hits = 0;
    let numCovered = 0;
    for (const ruleId of rules) {
      const count = coverMapFile.get(ruleId);
      if (count !== undefined) {
        hits += count;
        numCovered += 1;
      }
    }

    const numRulesLine = rules.length;
    if (numRulesLine === 1) {
      lines.push(format(LINE_TEMPLATE_NO_BRANCH, { line_num: lineNum, hits }));
    } else {
      lines.push(
        format(LINE_TEMPLATE_BRANCH, {
          line_num: lineNum,
          hits,
          // `int(rate * 100)` (`:169`) — truncation, not rounding: 2 of 3 rules
          // is `66%`, not `67%`.
          rule_rate: Math.trunc((numCovered / numRulesLine) * 100),
          rules_covered: numCovered,
          num_rules: numRulesLine,
        }),
      );
    }
  }

  return lines;
}
