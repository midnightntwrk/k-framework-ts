/**
 * The one module in this package that touches the filesystem, behind the `./fs`
 * subpath — the same split `@kframework-ts/k-parser` uses for `./slurp`.
 * Importing `@kframework-ts/kcovr` never pulls `node:fs` in.
 *
 * It is the *file discovery* half of `create_cover_map` (`kcovr.py:197-217`)
 * and `create_rule_map` (`:178-194`): which files a definition directory
 * contributes, and in which order.  The counting and rendering halves are pure
 * and live in `hits.ts` and `cobertura.ts`.  Two more readers join it for the
 * commands that need the definition itself —
 * {@link readKompiledJsonDefinition} and {@link translateCoverageFromPaths},
 * the path-taking half of `translate_coverage_from_paths`
 * (`coverage.py:108-133`).
 *
 * # Where a hit log comes from, and why there are so many
 *
 * `kompile --coverage` rewrites every rule's right-hand side into
 * `sideEffect:<Sort>(#logToFile(<path>, <uid> + "\n"), <rhs>)`
 * (`GenerateCoverage.java:66-78`), baking an **absolute** path — the definition
 * directory's `coverage.txt` — into the definition itself.  At run time the
 * LLVM runtime's `#logToFile` hook (`io.cpp:559`) does not write to that path
 * directly.  It derives a per-process file from it (`io.cpp:526-557`):
 *
 * ```
 * <K_LOG_DIR | dirname(path)> / <K_LOG_PREFIX> <pid> _coverage.txt
 * ```
 *
 * - **`K_LOG_DIR`** replaces the directory the definition was compiled with.
 *   A run redirected this way leaves nothing in the definition directory at
 *   all, so {@link readCoverageDefinition} must be pointed at wherever the logs
 *   landed — pass that directory as a second definition with the same
 *   `allRules.txt`, or copy the logs back.
 * - **`K_LOG_PREFIX`** prepends a string to the filename.  The glob absorbs it:
 *   {@link COVERAGE_LOG_GLOB}'s `*` covers prefix and pid together.
 * - **`<pid>`** is why one corpus run leaves dozens of files rather than one.
 *   Each `krun` is its own process; `fixtures/cov-build/` vendors three of the
 *   63 that one panopticon corpus scan produced.
 *
 * The macro log, `coverage.txt`, is a different file with a different writer
 * (`ExpandMacros.java:131-144,286-289`) — appended to at kompile time *and* at
 * program-parse time — and is read by name, never by the glob.
 *
 * # Hit logs accumulate; nothing here resets them
 *
 * Every log is opened `"a+"` and flushed at `atexit` (`io.cpp:552,566`), so a
 * second run against the same directory **doubles every count** rather than
 * replacing it.  That is not a bug to route around, it is the format: a hit log
 * accumulates every application until the file is deleted. Resetting
 * is the caller's job and is one line — remove everything matching
 * {@link COVERAGE_LOG_GLOB} before the run whose coverage you want, which is
 * exactly what panopticon's harness does before its corpus scan
 * (`K/harness/commands/coverage.ts:99-107`).  Nothing in this package deletes a
 * file; see {@link HIT_LOGS_ARE_APPEND_ONLY}.
 *
 * # What is *not* here: source-file reads
 *
 * The plan sketches "read source files for line counts", and there is no such
 * read, because Cobertura line counts do not come from the sources.
 * `render_coverage_xml` never opens one: `count_lines_file` (`kcovr.py:243-244`)
 * counts distinct positions in the **rule map**, and the source paths are used
 * only as `str(path)` and `path.relative_to(...)`.  pyk's `parse_args`
 * (`:70-71`) does touch them, to validate existence and `.resolve()` them, and
 * {@link resolveSourcePath} is that — the resolution, without the existence
 * check, so a report can be produced for a definition whose sources are not on
 * this machine (which is how `fixtures/PROVENANCE.md` mints the golden).
 */

import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { type KDefinition, readKastDefinitionFromJson } from "@kframework-ts/kast";

import type { CoverageDefinition } from "./cobertura.js";
import { MissingCoverageFileError } from "./errors.js";
import type { RuleId } from "./hits.js";
import { translateCoverage } from "./translate.js";

/**
 * The glob a definition directory's per-run hit logs match.
 *
 * `io.cpp:526-557` names each one
 * `<K_LOG_DIR | dirname(coverage.txt)>/<K_LOG_PREFIX><pid>_coverage.txt`, so
 * the `*` absorbs both `K_LOG_PREFIX` and the pid, and a run redirected by
 * `K_LOG_DIR` is still matched by this pattern in whatever directory it landed
 * in.
 *
 * The macro log, `coverage.txt` (`ExpandMacros.java:131-144`), is deliberately
 * **not** matched: it has no `_coverage.txt` suffix and is read by name.
 */
export const COVERAGE_LOG_GLOB = "*_coverage.txt";

/**
 * The macro-application log `kompile` and `krun` both append to
 * (`ExpandMacros.java:131-144,286-289`).
 *
 * Two writers interleave into it — one at kompile time, one at program-parse
 * time — and a macro-free semantics leaves it **zero bytes**, which is a real
 * case and not a missing file: `fixtures/cov-build/coverage.txt` is that case.
 */
export const MACRO_LOG_NAME = "coverage.txt";

/** The rule-location index every report joins against (`Kompile.java:363-382`). */
export const ALL_RULES_NAME = "allRules.txt";

/**
 * The KAST definition `kompile --emit-json` writes, read by `kcovr rules` and
 * by the destination side of `kcovr translate`
 * (`read_kast_definition(kompiled_dir / 'compiled.json')`, `coverage.py:127`,
 * `__main__.py:404`).
 *
 * **Not written without `--emit-json`**, which is not `kompile`'s default, so a
 * definition directory that reports coverage happily can still be unable to
 * pretty-print a rule.  That is why it is read by the two commands that need it
 * rather than by {@link readCoverageDefinition}.
 */
export const COMPILED_JSON_NAME = "compiled.json";

/**
 * Hit logs are opened in **append** mode and flushed at `atexit`
 * (`io.cpp:526-572`), so they accumulate across every run against the same
 * definition directory.  Resetting is the caller's job: delete everything
 * matching {@link COVERAGE_LOG_GLOB} before the run whose coverage you want.
 *
 * Named rather than inlined because this is the single most surprising property
 * of the format, and callers that get it wrong get plausible-looking wrong
 * numbers rather than an error.
 */
export const HIT_LOGS_ARE_APPEND_ONLY = true;

/**
 * Read one definition directory's coverage artifacts into the pure API's
 * {@link CoverageDefinition} — the file-discovery half of `create_cover_map`
 * (`kcovr.py:205-215`) and `create_rule_map` (`:181-183`).
 *
 * Files are collected in pyk's order — `coverage.txt`, then each
 * `*_coverage.txt` — with the glob **sorted by name**, because a directory's
 * readdir order is not defined and nothing about the result may depend on it.
 * Counts are order-independent anyway; the sort is so that two runs of
 * `kcovr hits` on the same directory produce the same bytes.
 *
 * Two absences that pyk treats as fatal are ordinary here:
 *
 * - **no `coverage.txt`** — pyk opens it unguarded (`:206`) and dies with
 *   `FileNotFoundError` on any semantics whose `kompile` never wrote one.
 *   Skipped.
 * - **no `*_coverage.txt`** — a definition that has been built but never run.
 *   The report is then all zeros, which is the true answer.
 *
 * `allRules.txt` is required: without it there is nothing to report against.
 *
 * @throws {MissingCoverageFileError} the directory has no `allRules.txt`.
 */
export async function readCoverageDefinition(dir: string): Promise<CoverageDefinition> {
  const allRulesTxt = await readAllRules(dir);

  const logNames = await coverageLogNames(dir);
  const coverageLogs = await Promise.all(logNames.map((name) => readFile(join(dir, name), "utf8")));

  return { name: dir, allRulesTxt, coverageLogs };
}

/** {@link readCoverageDefinition} over several directories, in the order given. */
export function readCoverageDefinitions(dirs: Iterable<string>): Promise<CoverageDefinition[]> {
  return Promise.all([...dirs].map((dir) => readCoverageDefinition(dir)));
}

/**
 * The hit logs a directory contributes, in read order: the macro log if it
 * exists, then every `*_coverage.txt` sorted by name.
 *
 * Exported because "which files did that number come from?" is the first
 * question anyone asks of a coverage report, and answering it should not
 * require re-deriving the glob.
 */
export async function coverageLogNames(dir: string): Promise<string[]> {
  const suffix = COVERAGE_LOG_GLOB.slice(1);
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);

  const names: string[] = [];
  let hasMacroLog = false;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name === MACRO_LOG_NAME) hasMacroLog = true;
    else if (entry.name.endsWith(suffix)) names.push(entry.name);
  }
  names.sort();
  return hasMacroLog ? [MACRO_LOG_NAME, ...names] : names;
}

/**
 * Normalize a source-file argument the way `pyk-covr` does — `Path.resolve()`
 * (`kcovr.py:71`) — so it can be compared against the absolute paths
 * `allRules.txt` records.
 *
 * The existence check pyk pairs it with (`file_path`, `:71`) is **not** done: a
 * definition directory is a portable artifact and its `Source` paths routinely
 * name a machine that is not this one — `/nix/store/…` prelude paths, a CI
 * container, or `fixtures/`'s sanitized `/fix/…` roots.  Refusing to report on
 * it would make the fixtures unusable and the tool unusable in exactly the case
 * it is most wanted.  An absolute path is returned unchanged, so a path that is
 * already `allRules.txt`-shaped never moves.
 */
export function resolveSourcePath(path: string): string {
  return isAbsolute(path) ? path : resolve(path);
}

/**
 * Read a file this package treats as opaque text — a hit log named directly, or
 * a `kore-exec` debug log.
 *
 * The two commands that take a *file* rather than a definition directory
 * (`kcovr rules`, `kcovr kore-log`) need this, and it lives here so that
 * `cli.ts` still imports `node:fs` through exactly one module.  No parsing, no
 * error wrapping: a missing file surfaces as node's own `ENOENT`, which names
 * the path, and there is nothing this layer could usefully add to it.
 */
export function readTextFile(path: string): Promise<string> {
  return readFile(path, "utf8");
}

/**
 * Read a definition directory's `compiled.json` — `read_kast_definition`
 * (`outer.py:1424-1426`), through `@kframework-ts/kast`'s v4 reader.
 *
 * The reader accepts **KAST v4 only** (`kast/src/json.ts`), which is a real
 * constraint on the inputs to `kcovr rules` and `kcovr translate`: a directory
 * built by K 7.1.x before the v4 switch carries `"version": 3` and is rejected
 * rather than lifted.  The error comes from `kast` and says which version it
 * found.  `fixtures/generators/sanitize-cov-build.py` refuses a v3 build for the
 * same reason rather than rewriting one, so this package's own fixture is a v4
 * file because `kompile` emitted a v4 file.
 *
 * @throws {MissingCoverageFileError} the directory has no `compiled.json`,
 *   which normally means it was kompiled without `--emit-json`.
 */
export async function readKompiledJsonDefinition(dir: string): Promise<KDefinition> {
  const json = await readFile(join(dir, COMPILED_JSON_NAME), "utf8").catch(() => {
    throw new MissingCoverageFileError(
      dir,
      COMPILED_JSON_NAME,
      "kompile writes it only with --emit-json, which is not the default. Rebuild the definition with " +
        "`kompile --coverage --emit-json` to pretty-print or translate its rules.",
    );
  });
  return readKastDefinitionFromJson(json);
}

/**
 * Translate a hit file from one definition directory onto another —
 * `translate_coverage_from_paths` (`coverage.py:108-133`).
 *
 * ```ts
 * const dstHits = await translateCoverageFromPaths("old-kompiled", "new-kompiled", "old-kompiled/1234_coverage.txt");
 * ```
 *
 * Reads three files and one definition: each directory's `allRules.txt`, the
 * destination's `compiled.json`, and the hit file named — which is *a* file, not
 * the directory's whole log set, exactly as upstream takes one. Use
 * {@link readCoverageDefinition} with `translateCoverageFromDefinitions` to
 * translate everything a directory has logged.
 *
 * @throws {MissingCoverageFileError} a required file is absent.
 * @throws {UnknownSourceRuleError} a hit is unknown to the source build.
 * @throws {UnknownTargetLocationError} a rule's location is unknown to the
 *   destination build.
 */
export async function translateCoverageFromPaths(
  srcDefinitionDir: string,
  dstDefinitionDir: string,
  srcRulesFile: string,
): Promise<RuleId[]> {
  const [src, dst, dstDefinition, hits] = await Promise.all([
    readAllRules(srcDefinitionDir),
    readAllRules(dstDefinitionDir),
    readKompiledJsonDefinition(dstDefinitionDir),
    readFile(srcRulesFile, "utf8"),
  ]);
  return translateCoverage(src, dst, dstDefinition, hits.split("\n"));
}

/**
 * One directory's `allRules.txt`, with {@link readCoverageDefinition}'s error.
 *
 * Not exported: a caller who wants the file wants {@link readCoverageDefinition},
 * which also finds the hit logs.
 */
function readAllRules(dir: string): Promise<string> {
  return readFile(join(dir, ALL_RULES_NAME), "utf8").catch(() => {
    throw new MissingCoverageFileError(
      dir,
      ALL_RULES_NAME,
      "kompile writes it into every definition directory, with or without --coverage " +
        "(Kompile.java:363-382). Point --definition at a *-kompiled directory.",
    );
  });
}
