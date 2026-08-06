/**
 * Hit-log parsing — `create_cover_map` (`kcovr.py:197-217`), with the
 * filesystem taken out of it.
 *
 * A hit log is the simplest format in this monorepo: **one 64-lowercase-hex
 * `UNIQUE_ID` per line, one line per rule application**.  The LLVM runtime
 * appends a line every time an instrumented right-hand side fires
 * (`GenerateCoverage.java:66-78` builds the `#logToFile` call, `io.cpp:526-572`
 * performs the write), so the file is a *log*, not a set: 362 lines naming 31
 * distinct rules is a normal file, and it is exactly what
 * `fixtures/cov-build/pid-large_coverage.txt` is.
 *
 * That is the whole reason this module exists as more than a `Set`
 * constructor.  Counting is the point — `hits="72"` in a Cobertura `<line>` is
 * a sum of applications, not a count of rules.
 *
 * ## What is transcribed
 *
 * pyk's `create_cover_map` walks each definition directory, opens
 * `coverage.txt` and then every `*_coverage.txt`, and increments a plain dict
 * (`:200-203`).  The *file discovery* half of that lives in `fs.ts`, where the
 * `node:fs` import is allowed; what is here is the half that is a function of
 * strings, so a caller with logs from a zip, an HTTP range read or a test
 * literal gets the same answer as one with a directory.
 *
 * Multi-log and multi-directory merging is the same operation in both: pyk
 * accumulates every file of every directory into one dict, so
 * {@link createCoverMap} takes an iterable of texts and merging is just passing
 * more of them.
 *
 * ## Deliberate deviations
 *
 * - **Blank lines are skipped.**  pyk's loop is `for line in f: add_cover(line.strip())`
 *   with no emptiness check (`:207-209`), so a log containing a blank line
 *   records a rule whose id is the empty string, and the report then dies with
 *   a `KeyError` at `kcovr.py:254` because no `allRules.txt` entry has that id.
 *   Python's file iteration never yields a phantom final line, so a
 *   *trailing newline* is already safe upstream; an interior blank line is not.
 *   Skipping both is what plan §4 item 1 specifies and costs nothing: no rule
 *   id is ever empty.
 * - **Whitespace is stripped, as upstream strips it** (`:208`).  This is not
 *   cosmetic tolerance — it is what makes a `\r\n`-terminated log read on a
 *   machine that did not write it.
 *
 * Nothing else about the grammar is validated.  A line that is not 64 hex
 * characters is counted as written and surfaces later as an `unknownIds`
 * diagnostic from `cobertura.ts`, which is a better report than a parse error:
 * the caller learns *which* ids their build does not know, rather than that
 * byte 3 of line 291 was wrong.
 */

/**
 * A rule's `UNIQUE_ID` — the 64-character lowercase hex SHA3-256 of the
 * normalized sentence (`NumberSentences.java:26-54`; pyk's docstring says
 * SHA-256, which is wrong).
 *
 * This is one of the two identity spaces in this package and they never mix.
 * The other, `LocationKey`, belongs to the legacy haskell-log analyzer and is a
 * `file:l:c-l:c` range with no hash in it at all.  The bridge between them is
 * `allRules.txt`; nothing in the API blurs it.
 */
export type RuleId = string;

/**
 * How many times each rule was applied.  A rule that never fired is **absent**,
 * never present with a count of zero — `create_cover_map` only ever sees ids
 * that were logged.
 */
export type CoverMap = ReadonlyMap<RuleId, number>;

/**
 * Count rule applications across any number of hit logs
 * (`kcovr.py:197-217`, minus the directory walk).
 *
 * ```ts
 * const hits = createCoverMap([macroLog, ...perRunLogs]);
 * hits.get("3f2a…"); // 72 applications
 * ```
 *
 * Order of the texts is irrelevant to the result and irrelevant to iteration
 * order of anything downstream: `cobertura.ts` sorts what it emits, and
 * `allRules.txt` iteration order is arbitrary anyway (plan §4 item 11).
 *
 * @param texts hit-log contents — `coverage.txt`, `<pid>_coverage.txt`, or
 *   anything else with one rule id per line.
 */
export function createCoverMap(texts: Iterable<string>): CoverMap {
  const coverMap = new Map<RuleId, number>();
  for (const text of texts) {
    for (const rawLine of text.split("\n")) {
      // `line.strip()` (kcovr.py:208), plus the blank-line skip pyk lacks.
      const ruleId = rawLine.trim();
      if (ruleId === "") continue;
      coverMap.set(ruleId, (coverMap.get(ruleId) ?? 0) + 1);
    }
  }
  return coverMap;
}

/**
 * Total applications recorded — the sum of every count, as distinct from
 * `coverMap.size`, the number of *distinct* rules that ran.
 *
 * The distinction is the one thing readers of this format get wrong, so it has
 * a name rather than an inline `reduce` at each call site.
 */
export function totalHits(coverMap: CoverMap): number {
  let total = 0;
  for (const count of coverMap.values()) total += count;
  return total;
}
