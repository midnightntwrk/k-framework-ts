/**
 * **LEGACY.**  The haskell-backend one-line debug-log analyzer —
 * `kore_exec_covr/kore_exec_covr.py` and `kore_exec_covr/__main__.py`,
 * transcribed whole.
 *
 * This module is labelled legacy in its entirety, and the label is not a
 * hedge — it is plan §0(b) and §6:
 *
 * - **The format it parses is no longer emitted.**  `kore-exec` used to print a
 *   rule's source location after `Debug (DebugAppliedRewriteRules):`; the
 *   current haskell-backend prints `"applied N rewrite rules"` instead
 *   (`DebugAppliedRewriteRules.hs:69-73`).  A log from a current `kore-exec`
 *   run therefore yields entries whose payload is prose, counted under that
 *   prose as though it were a location.
 * - **Its 7-case unit table is the entire specification.**
 *   `pyk/src/tests/unit/test_kore_exec_covr.py` is the only test upstream has
 *   for *any* of K's coverage tooling, nothing can regenerate a sample of the
 *   format, and no second authority exists.  The table is vendored verbatim at
 *   `fixtures/pyk-unit/kore-exec-covr-cases.json` and
 *   `test/koreExecLog.test.ts` runs every case against this code.
 * - **Its successor exists.**  `--log-format json` (`oneLineJson`) carries
 *   `rule_id` and `location` as fields rather than as a substring, which is
 *   what anything new should read.  Parsing it is out of scope until something
 *   in this workspace consumes it (plan §6).
 *
 * It ships anyway because a `kore-exec` log from an older toolchain is a real
 * artifact that people still have, and because `kore-exec-covr` is one of pyk's
 * three published entry points, so parity has a caller.
 *
 * ## A different identity space
 *
 * Nothing here touches `UNIQUE_ID`.  This tool keys on
 * `` `${source}:${startLine}:${startCol}-${endLine}:${endCol}` `` — a source
 * *range* read out of a log line and matched against `Atts.SOURCE` /
 * `Atts.LOCATION` in the definition.  There is no hash anywhere in it, and it
 * has nothing to do with `--coverage`, `allRules.txt` or hit logs; the two tools
 * merely share a directory upstream (plan §0(d)).  {@link LocationKey} and
 * `RuleId` are kept as separate types so the two can never be crossed by
 * accident.
 *
 * ## Deliberate deviations
 *
 * 1. **Warnings are returned, not logged.**  pyk calls
 *    `_LOGGER.warning(...)` (`kore_exec_covr.py:51,93`), which writes to
 *    whatever logging the process configured — invisible to a library caller and
 *    untestable without a capture fixture.  {@link parseRuleApplications} and
 *    {@link buildRuleDict} return their warnings as data instead; `cli.ts` is
 *    what puts them on stderr, so the CLI still behaves as pyk's does
 *    (including `--quiet`, `__main__.py:94`).  The **wording** of each warning
 *    is upstream's.
 * 2. **`parseRuleApplications` takes text, not a `Path`** (`:29,45`), like every
 *    other pure function here.  The file read moves to `fs.ts`.
 * 3. **The two counters are named fields** rather than a dict keyed by the
 *    `HaskellLogEntry` enum (`:60-63`).  Same content; `rewrites` and
 *    `simplifications` say what they are, and the test table maps its enum keys
 *    onto them explicitly.
 *
 * ## Deliberate non-fixes
 *
 * Three things about this format look like bugs and are kept, because
 * `test_kore_exec_covr.py` pins all three (plan §4 item 8):
 *
 * - a line with **several locations** stays **one** composite space-joined key
 *   (`:36-41`) — it is not split;
 * - an **empty** payload becomes the literal key `UNKNOWN` (`:53-54`), which
 *   collects every generated-projection application into one bucket;
 * - an unparseable line is **warned about and skipped** (`:51`), never fatal.
 *
 * And one that is a typo rather than a bug: the report says `availible`
 * (`__main__.py:45-46`).  It is reproduced, because the report is the output
 * contract and a diff against pyk's own is the only check this module can be
 * given.  If upstream ever fixes the spelling, so does this line.
 */

import { Atts, type KDefinition, type KRule } from "@kframework-ts/kast";

//////////////////////////////
// Log entries              //
//////////////////////////////

/**
 * The two `kore-exec` debug entries this tool understands — `HaskellLogEntry`
 * (`kore_exec_covr.py:24-26`).
 *
 * A `const` object plus a union type rather than a TS `enum`: the *values* are
 * the wire format (they are what the log line spells and what the vendored test
 * table keys on), and a union of string literals keeps them comparable to a
 * parsed substring without a cast.
 */
export const HaskellLogEntry = {
  /** A simplification: an equation was applied. */
  DEBUG_APPLY_EQUATION: "DebugApplyEquation",
  /** A rewrite step. */
  DEBUG_APPLIED_REWRITE_RULES: "DebugAppliedRewriteRules",
} as const;

/** One of the two {@link HaskellLogEntry} values. */
export type HaskellLogEntry = (typeof HaskellLogEntry)[keyof typeof HaskellLogEntry];

/** Every entry name this module recognises, for the membership test in the parser. */
const HASKELL_LOG_ENTRIES: ReadonlySet<string> = new Set(Object.values(HaskellLogEntry));

/**
 * `_HASKELL_LOG_ENTRY_REGEXP` (`kore_exec_covr.py:21`), transcribed **verbatim**
 * — only the `u` flag is added, which changes nothing about what it matches
 * here and is what this repo's lint requires.
 *
 * Three details are upstream's and are not to be tidied:
 *
 * - `\d*` accepts an **empty** bracket pair, so `[] Debug (…)` parses;
 * - only `kore-exec` and `kore-rpc` are accepted, not `kore-repl` or a path;
 * - `([a-zA-Z]*)` is the entry name, and an unrecognised one is dropped by
 *   {@link parseHaskellOnelineLog} rather than by the pattern.
 *
 * `match` semantics: Python's `re.match` anchors at the start of the string but
 * not at the end, which `RegExp.exec` with a leading `^` reproduces.  `.` does
 * not match a newline in either language, and callers split the text into lines
 * first anyway.
 */
export const HASKELL_LOG_ENTRY_REGEXP = /^(kore-exec|kore-rpc): \[\d*\] Debug \(([a-zA-Z]*)\):(.*)/u;

/** What one recognised log line says — pyk's `(HaskellLogEntry, str)` tuple, named. */
export interface HaskellLogLine {
  /** Which debug entry the line reports. */
  readonly entry: HaskellLogEntry;
  /**
   * Everything after the colon, `.strip()`ed (`kore_exec_covr.py:72`).
   *
   * Usually one `file:l:c-l:c` location; sometimes several, space-joined;
   * sometimes empty, which {@link parseRuleApplications} turns into
   * {@link UNKNOWN_LOCATION}.
   */
  readonly payload: string;
}

/**
 * Parse one line of a `--log-format oneline` haskell-backend log —
 * `_parse_haskell_oneline_log` (`kore_exec_covr.py:66-75`).
 *
 * Returns `null` for anything that is not one of the two recognised entries:
 * a line that does not match the pattern at all, and a line that matches but
 * names some other entry (pyk gets the second case from `HaskellLogEntry(entry)`
 * raising `ValueError`, which `:74` catches — the enum lookup *is* the filter).
 *
 * The payload is trimmed but otherwise untouched: backslash-escaped spaces in a
 * path stay escaped, and several locations on one line stay one string.
 */
export function parseHaskellOnelineLog(line: string): HaskellLogLine | null {
  const match = HASKELL_LOG_ENTRY_REGEXP.exec(line);
  if (match === null) return null;

  const entry = match[2] ?? "";
  if (!HASKELL_LOG_ENTRIES.has(entry)) return null;

  // `.strip()` (`:72`).  Python strips all whitespace including `\r`, which is
  // what makes a CRLF log read on the machine that did not write it.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- membership checked above
  return { entry: entry as HaskellLogEntry, payload: (match[3] ?? "").trim() };
}

//////////////////////////////
// Counting applications    //
//////////////////////////////

/**
 * A `file:startLine:startCol-endLine:endCol` range, the identity space of this
 * module (`kore_exec_covr.py:105-107`).
 *
 * Not a `RuleId` and never convertible to one without `allRules.txt`; see the
 * module header.
 */
export type LocationKey = string;

/**
 * The bucket every application with an empty location goes into
 * (`kore_exec_covr.py:53-54`).
 *
 * pyk's docstring guesses why there are so many: "It seems likely that those
 * are generated projection rules" (`:38-40`).  They are reported in bulk rather
 * than dropped, so the totals stay honest.
 */
export const UNKNOWN_LOCATION: LocationKey = "UNKNOWN";

/** What `parse_rule_applications` returns (`kore_exec_covr.py:60-63`), plus the warnings. */
export interface RuleApplications {
  /** `DebugAppliedRewriteRules` — rewrite steps, by location, in first-seen order. */
  readonly rewrites: ReadonlyMap<LocationKey, number>;
  /** `DebugApplyEquation` — simplifications, by location, in first-seen order. */
  readonly simplifications: ReadonlyMap<LocationKey, number>;
  /**
   * One entry per skipped line, in pyk's wording (`:51`).
   *
   * Never empty for a log that contains anything other than these two debug
   * entries — which is most real logs, since `kore-exec` interleaves other
   * output — so a caller that treats a non-empty list as an error will be wrong.
   * `cli.ts` prints them and carries on, as pyk's logger does.
   */
  readonly warnings: readonly string[];
}

/**
 * Count rule applications in a one-line haskell log —
 * `parse_rule_applications` (`kore_exec_covr.py:29-63`).
 *
 * ```ts
 * const { rewrites, simplifications } = parseRuleApplications(logText);
 * rewrites.get("/k/domains.md:1:2-3:4"); // 17 applications
 * ```
 *
 * Two counters, one pass, insertion-ordered: the report prints them in the
 * order their locations were first seen, which is pyk's dict order and
 * therefore the order of first application in the run.
 */
export function parseRuleApplications(text: string): RuleApplications {
  const rewrites = new Map<LocationKey, number>();
  const simplifications = new Map<LocationKey, number>();
  const warnings: string[] = [];

  // `read_text().splitlines()` (`:45`) — an empty file yields no lines at all,
  // which is the `empty` case of the vendored table, and a trailing newline
  // yields no phantom last line.
  for (const line of splitLines(text)) {
    const parsed = parseHaskellOnelineLog(line);
    if (parsed === null) {
      warnings.push(`Skipping log entry, failed to parse: ${line}`);
      continue;
    }

    const location = parsed.payload === "" ? UNKNOWN_LOCATION : parsed.payload;
    const counter = parsed.entry === HaskellLogEntry.DEBUG_APPLIED_REWRITE_RULES ? rewrites : simplifications;
    counter.set(location, (counter.get(location) ?? 0) + 1);
  }

  return { rewrites, simplifications, warnings };
}

/**
 * Python's `str.splitlines()`, restricted to the line terminators a log file can
 * contain.
 *
 * The difference from `text.split("\n")` that matters is the last one: Python
 * yields nothing for `''` and drops the empty final element after a trailing
 * newline, so a file ending in `\n` does not contribute a blank line to be
 * warned about.  `\r\n` is handled because a log copied off another machine is
 * a normal thing to have; the exotic separators `splitlines` also honours
 * (`\v`, `\x1c`, `
`, …) are not, and cannot appear here.
 */
function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split(/\r\n|\r|\n/u);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

//////////////////////////////
// The definition side      //
//////////////////////////////

/** Options for {@link buildRuleDict} — `build_rule_dict`'s keyword arguments (`:78-80`). */
export interface RuleDictOptions {
  /** Skip rules carrying `Atts.PROJECTION`.  Default `true`, as upstream. */
  readonly skipProjections?: boolean;
  /** Skip rules carrying `Atts.INITIALIZER`.  Default `true`, as upstream. */
  readonly skipInitializers?: boolean;
}

/** What {@link buildRuleDict} returns: pyk's dict, plus the warnings it logs. */
export interface RuleDict {
  /** `file:l:c-l:c` → the rule declared there.  Later rules win a collision, as in pyk. */
  readonly rules: ReadonlyMap<LocationKey, KRule>;
  /** One entry per rule skipped for want of a location, in pyk's wording (`:93`). */
  readonly warnings: readonly string[];
}

/**
 * Index a definition's rules by source range — `build_rule_dict`
 * (`kore_exec_covr.py:78-102`).
 *
 * The two skips are upstream's defaults and exist because both kinds of rule are
 * *generated*: a `projection` rule extracts an argument out of a constructor and
 * a `initializer` rule builds the initial configuration, and neither is
 * something a reader of a coverage report wrote or can act on.  They are also
 * the rules most likely to appear with an empty location in the log, which is
 * why {@link UNKNOWN_LOCATION} exists.
 *
 * A rule missing `Source` or `Location` is skipped with a warning.  pyk writes
 * that warning with a Python `f'…{str(rule.body):.100}...<truncated>'`, i.e. the
 * first 100 characters of the body's `repr`; the equivalent here is 100
 * characters of the body's JSON, which is the same *kind* of unhelpful hint and
 * is at least a stable one.  (pyk's `except KeyError` branch also assigns
 * `rule_source = None` before `continue`, and its trailing `else: raise
 * ValueError` at `:100` is unreachable for that reason — dead code, not
 * transcribed.)
 */
export function buildRuleDict(definition: KDefinition, options: RuleDictOptions = {}): RuleDict {
  const { skipProjections = true, skipInitializers = true } = options;

  const rules = new Map<LocationKey, KRule>();
  const warnings: string[] = [];

  for (const rule of definition.rules) {
    if (skipProjections && rule.att.has(Atts.PROJECTION)) continue;
    if (skipInitializers && rule.att.has(Atts.INITIALIZER)) continue;

    const source = rule.att.get(Atts.SOURCE);
    const location = rule.att.get(Atts.LOCATION);
    if (source === undefined || location === undefined) {
      warnings.push(`Skipping rule with no location information ${truncatedBody(rule)}...<truncated>`);
      continue;
    }

    rules.set(locationKey(source, location), rule);
  }

  return { rules, warnings };
}

/** `f'{rule_source}:{_location_tuple_to_str(rule_location)}'` (`kore_exec_covr.py:98,105-107`). */
export function locationKey(source: string, location: readonly [number, number, number, number]): LocationKey {
  const [startLine, startCol, endLine, endCol] = location;
  return `${source}:${startLine}:${startCol}-${endLine}:${endCol}`;
}

/** `f'{str(rule.body):.100}'` (`kore_exec_covr.py:93`), in the only spelling TS has. */
function truncatedBody(rule: KRule): string {
  return JSON.stringify(rule.body).slice(0, 100);
}

//////////////////////////////
// The report               //
//////////////////////////////

/** Options for {@link renderKoreExecReport} — what `do_analyze` gets from `argparse`. */
export interface KoreExecReportOptions {
  /**
   * What to call the definition in the first line — `do_analyze`'s
   * `definition_dir` (`__main__.py:36`).
   *
   * A label, not a path this module reads: the definition arrives already
   * parsed.  `cli.ts` passes the directory the user named.
   */
  readonly definitionDir: string;
}

/** The rendered report, plus everything pyk would have logged or discarded. */
export interface KoreExecReport {
  /** The report exactly as `do_analyze` prints it, newline-terminated. */
  readonly text: string;
  /** `sum(v for v in applied_rewrites.values() if v > 0)` (`__main__.py:61`). */
  readonly totalRewrites: number;
  /** `sum(v for v in applied_simplifications.values() if v > 0)` (`__main__.py:73`). */
  readonly totalSimplifications: number;
  /** Every warning from {@link buildRuleDict} and {@link parseRuleApplications}, in that order. */
  readonly warnings: readonly string[];
}

/**
 * Render `kore-exec-covr`'s report — `do_analyze` (`__main__.py:22-74`), with
 * `print` replaced by string building.
 *
 * ```
 * Discovering rewrite and simplification rules in <definitionDir>
 *     Found 12 rewrite rules availible for MY-MODULE
 *     Found 3 simplification rules availible for MY-MODULE
 * =================================
 * === REWRITES ====================
 * =================================
 *     7 applications of rule [my-label] defined at /s/a.k:1:1-2:2
 * Total rewrites applied: 7
 * =================================
 * === SIMPLIFICATIONS =============
 * =================================
 * Total applied simplifications: 0
 * ```
 *
 * Three details of that text are contractual and none is an accident:
 *
 * - **`availible`** — upstream's spelling (`:45-46`).  See the module header.
 * - **The label is `[…]` from `Atts.LABEL` for rewrites but `Atts.SYMBOL` for
 *   simplifications** (`:57-58` vs `:69-70`), which is not a slip: a
 *   `simplification` rule is attached to a function symbol and typically has no
 *   `label`.
 * - **A location the definition does not know prints with an empty label**, and
 *   because the label is interpolated unconditionally the line then contains
 *   *two* spaces: `"applications of rule  defined at"`.  Every `UNKNOWN` line
 *   looks like that.
 *
 * The `if hits > 0` guards (`:59,71`) are transcribed although a counter never
 * holds a zero — they are what makes the printed lines and the totals agree by
 * construction rather than by argument.
 */
export function renderKoreExecReport(
  definition: KDefinition,
  logText: string,
  options: KoreExecReportOptions,
): KoreExecReport {
  const { rules, warnings: ruleWarnings } = buildRuleDict(definition);

  let definedRewrites = 0;
  let definedSimplifications = 0;
  for (const rule of rules.values()) {
    if (rule.att.has(Atts.SIMPLIFICATION)) definedSimplifications += 1;
    else definedRewrites += 1;
  }

  const applications = parseRuleApplications(logText);

  const lines: string[] = [
    `Discovering rewrite and simplification rules in ${options.definitionDir}`,
    `    Found ${definedRewrites} rewrite rules availible for ${definition.mainModuleName}`,
    `    Found ${definedSimplifications} simplification rules availible for ${definition.mainModuleName}`,
  ];

  const totalRewrites = section(lines, "=== REWRITES ====================", applications.rewrites, rules, Atts.LABEL);
  lines.push(`Total rewrites applied: ${totalRewrites}`);

  const totalSimplifications = section(
    lines,
    "=== SIMPLIFICATIONS =============",
    applications.simplifications,
    rules,
    Atts.SYMBOL,
  );
  lines.push(`Total applied simplifications: ${totalSimplifications}`);

  return {
    text: `${lines.join("\n")}\n`,
    totalRewrites,
    totalSimplifications,
    warnings: [...ruleWarnings, ...applications.warnings],
  };
}

/**
 * An attribute value as pyk's `f'{value}'` would print it.
 *
 * `Atts.SYMBOL` is a string and `Atts.LABEL` is `ANY_TYPE`, i.e. any JSON —
 * which in every real definition is also a string.  Python would print
 * `str(dict)` for the exotic case; JSON is this language's nearest reading of
 * the same value, and it is at least unambiguous where `String(obj)` would say
 * `[object Object]`.
 */
function attText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** The `=` banner (`__main__.py:52-54,64-66`) — 33 characters wide, and the width is the header's. */
const BANNER = "=".repeat(33);

/**
 * One `REWRITES` / `SIMPLIFICATIONS` section, appended to `lines`; returns its
 * total.
 *
 * `labelKey` is the only difference between the two (`Atts.LABEL` at `:57`,
 * `Atts.SYMBOL` at `:69`), which is why they share a function here where
 * upstream repeats itself.
 */
function section(
  lines: string[],
  heading: string,
  applications: ReadonlyMap<LocationKey, number>,
  rules: ReadonlyMap<LocationKey, KRule>,
  labelKey: typeof Atts.LABEL | typeof Atts.SYMBOL,
): number {
  lines.push(BANNER, heading, BANNER);

  let total = 0;
  for (const [location, hits] of applications) {
    // `if location_str in rule_dict and Atts.X in rule_dict[…].att` — presence,
    // not truthiness, so a rule labelled `""` still prints `[]`.  `f'[{…}]'` on
    // whatever the attribute holds: `Atts.SYMBOL` is a string, `Atts.LABEL` is
    // `ANY_TYPE`, and pyk interpolates both with `str()`.
    const rule = rules.get(location);
    const labelStr = rule !== undefined && rule.att.has(labelKey) ? `[${attText(rule.att.get(labelKey))}]` : "";
    if (hits > 0) {
      lines.push(`    ${hits} applications of rule ${labelStr} defined at ${location}`);
      total += hits;
    }
  }
  return total;
}
