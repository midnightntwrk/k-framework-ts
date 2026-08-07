/**
 * The `kcovr` command.  Every subcommand is a pure function of its arguments
 * plus injected effects — `out`, `err`, and a clock — so the whole CLI is
 * tested without spawning a process; `bin.ts` is the only file here that
 * touches `process`.
 *
 * Six commands, complete at phase 5 of `docs/coverage-plan.md` §7:
 *
 * - **`report`** — `pyk-covr` parity (`kcovr.py:52-73`): a Cobertura 1.9
 *   document on stdout.
 * - **`hits`** — no upstream equivalent.  The quick "what actually ran" view:
 *   one line per rule that fired, with its count and its source location, which
 *   is the question `pyk coverage` answers only by pretty-printing whole rules.
 * - **`rules`** — `pyk coverage` parity (`__main__.py:403-413`): each id in a
 *   hit log, pretty-printed as the rule it names.
 * - **`translate`** — a CLI for `translate_coverage_from_paths`
 *   (`coverage.py:108-133`), which upstream exposes through no entry point at
 *   all.
 * - **`kore-log`** — `kore-exec-covr` parity (`kore_exec_covr/__main__.py`),
 *   the legacy haskell one-line log analyzer, which says so in `--help`.
 * - **`check-k`** — the house drift check over `ksources.ts`, with one
 *   difference from every sibling: **both** tiers decide the exit code.  In
 *   `kompiled` and `kore` the second tier is advisory; here it is the frozen
 *   unit-test table that is the legacy log format's only specification and the
 *   Java pass that decides the shape `stripCoverageLogger` strips, and a diff in
 *   either is a real finding.  `ksources.ts`' header argues it at length.
 *
 * ## Deviations from `pyk-covr`, all deliberate
 *
 * - **Both `++` and `--` separate definition directories from sources.**
 *   `pyk-covr` implements `++` (`:65`) while its own usage string says `--`
 *   (`:60`) and `bin/kcovr:20` implements `--`; passing `--` to `pyk-covr`
 *   fails with `Directory does not exist: …/--`.  `++` stays canonical in the
 *   docs.
 * - **The separator is required.**  `split_at_sep` (`:63-67`) returns every
 *   argument as a definition directory when there is no `++`, so `pyk-covr`
 *   with no separator renders a report with no classes and no error.  Here that
 *   is a usage error.
 * - **`--timestamp` exists.**  `:92` reads the clock; a report you cannot
 *   reproduce is a report you cannot diff.  Without the flag the clock is used,
 *   as upstream.
 * - **Source files need not exist.**  See `fs.ts`' {@link resolveSourcePath}:
 *   definition directories are portable and their `Source` paths routinely name
 *   another machine.
 * - **The XML is written verbatim.**  `main()` does `print(xml)` (`:55`), which
 *   appends a newline to a string that already ends in one.  The document ends
 *   with exactly one newline here, which is the form
 *   `fixtures/synthetic/golden.cobertura.xml` is pinned in.
 *
 * ## Deviations from `pyk coverage` (the `rules` command)
 *
 * `@kframework-ts/kast` exports `minimizeRuleLike`
 * (`manip.py:534-560`) and `removeSourceMap` (`:563`), and `rules` applies both
 * at the point `exec_coverage` does — the definition is stripped once before
 * the `PrettyPrinter` is built (`:405`), and each rule is minimized after its
 * coverage logger comes off (`:407`).  What remains:
 *
 * - **`PrettyPrinter`, not `Formatter`.**  Plan §1(c) suggested
 *   `@kframework-ts/kompiled`'s `prettyPrint`; it takes a `KInner` and cannot
 *   print a *sentence*, so it could only ever show a rule's body without its
 *   `rule` keyword, label, side conditions or attributes.  `pyk coverage` uses
 *   `PrettyPrinter(definition).print(rule)` (`__main__.py:406,412`), which
 *   `@kframework-ts/kast` transcribes and which prints the whole sentence, so
 *   that is what this uses.
 * - **One trailing newline.**  pyk's last `write` is the pretty-printed rule
 *   itself (`:413`), so its output does not end in a newline and a shell prompt
 *   lands mid-line.  One is appended here; every byte before it is pyk's.
 */

import { minimizeRuleLike, PrettyPrinter, removeSourceMap } from "@kframework-ts/kast";

import { createRuleMap, renderCoverageReport, type CoverageOptions } from "./cobertura.js";
import { KcovrError } from "./errors.js";
import {
  readCoverageDefinitions,
  readKompiledJsonDefinition,
  readTextFile,
  resolveSourcePath,
  translateCoverageFromPaths,
} from "./fs.js";
import { createCoverMap } from "./hits.js";
import { renderKoreExecReport } from "./koreExecLog.js";
import {
  checkKcovrSources,
  type KcovrSourceFetcher,
  type KcovrSourcesReport,
  type KcovrSourcesVerdict,
} from "./ksources.js";
import { getRuleById, stripCoverageLogger } from "./rules.js";
import { K_RELEASE, type KcovrSourceTier } from "./version.js";

const RAW = "https://raw.githubusercontent.com";

export const USAGE = `kcovr-ts <command>

  kcovr-ts report <definition-dir>... ++ <source-file>... [--timestamp <seconds>]
      Cobertura 1.9 XML on stdout, over the hit logs in each definition
      directory. '--' is accepted in place of '++'. --timestamp pins the
      document's timestamp (default: now) so two runs produce the same bytes.

  kcovr-ts hits <definition-dir>
      One line per rule that fired: UNIQUE_ID <TAB> applications <TAB>
      file:line:col, sorted by id. Hit logs are append-only — direct each run
      to a fresh K_LOG_DIR to measure it alone.

  kcovr-ts rules <definition-dir> <coverage-file>
      Pretty-print the rule behind every id in a hit log, coverage
      instrumentation stripped, minimized to the cells the rule touches, and
      with source paths dropped ('pyk coverage' parity). A hit log is a log, so
      a rule prints once per application; 'kcovr hits' is the deduplicated
      view. Needs a definition kompiled with --emit-json.

  kcovr-ts translate <src-def-dir> <dst-def-dir> <coverage-file>
      Remap a hit log recorded against one build onto another build's rule ids,
      one per line, in log order. Rules are matched by basename:line:col, and
      only <generatedTop>-rooted rules survive — function and simplification
      rules are dropped. Needs dst kompiled with --emit-json.

  kcovr-ts kore-log <log-file> --definition <dir> [--quiet]
      LEGACY. Report applied rewrites and simplifications from a haskell-backend
      log ('kore-exec-covr' parity). The format it reads — a source location
      after 'Debug (DebugAppliedRewriteRules):' — is one current kore-exec no
      longer emits; --log-format json is its successor. --quiet drops warnings.

  kcovr-ts check-k <k-release>
      Check whether the upstream sources this package was transcribed from, and
      the two it is checked against, are unchanged at a given K release, e.g.
      kcovr-ts check-k ${K_RELEASE}. Unlike its siblings, BOTH tiers decide the
      exit code; the report's footer says why.

Commands exit 0 on success, 1 on unreadable or contradictory input, 2 on a
usage error. For check-k the codes mean 0 unchanged, 1 changed, 3 could not
locate a path at that release, 2 could not ask. Rule coverage is LLVM-only: a
--coverage --backend haskell definition compiles but never logs (IO.hs:74-76
registers no #logToFile).`;

/** Reads the wall clock in **milliseconds**, injected so tests can pin it. */
export type Clock = () => number;

/**
 * `fetch`, reached through `globalThis` for the same reason as Web Crypto in
 * `ksources.ts`: the emit config has no ambient DOM types, and naming one here
 * would collide with Bun's under the development config.
 */
interface ResponseLike {
  readonly status: number;
  readonly ok: boolean;
  readonly statusText: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** Fetches raw file bytes from GitHub.  A 404 is "not at this revision". */
async function fetchRawFile(repo: string, path: string, revision: string): Promise<Uint8Array | undefined> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const { fetch } = globalThis as unknown as { fetch: (url: string) => Promise<ResponseLike> };
  const response = await fetch(`${RAW}/${repo}/${encodeURIComponent(revision)}/${path}`);
  // Only a clean 404 means "not at this tag".  Anything else is a failure to
  // ask, which must not be reported as a fact about K.
  if (!response.ok && response.status !== 404) {
    throw new Error(`GET ${repo}/${path} at ${revision}: HTTP ${response.status} ${response.statusText}`);
  }
  return response.status === 404 ? undefined : new Uint8Array(await response.arrayBuffer());
}

/** Fetches K's llvm-backend submodule gitlink through GitHub's contents API. */
async function fetchGitlink(revision: string): Promise<string | undefined> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const { fetch } = globalThis as unknown as { fetch: (url: string) => Promise<ResponseLike> };
  const response = await fetch(
    `https://api.github.com/repos/runtimeverification/k/contents/llvm-backend/src/main/native/llvm-backend?ref=${encodeURIComponent(revision)}`,
  );
  if (!response.ok && response.status !== 404) {
    throw new Error(
      `GET runtimeverification/k/llvm-backend/src/main/native/llvm-backend gitlink at ${revision}: HTTP ${response.status} ${response.statusText}`,
    );
  }
  if (response.status === 404) return undefined;
  const json = JSON.parse(new TextDecoder().decode(await response.arrayBuffer())) as unknown;
  if (typeof json !== "object" || json === null || !("sha" in json) || typeof json.sha !== "string") {
    throw new Error(
      `GET runtimeverification/k/llvm-backend/src/main/native/llvm-backend gitlink at ${revision}: malformed GitHub response`,
    );
  }
  return json.sha;
}

/** Fetches direct files and K's exact llvm-backend gitlink from GitHub. */
export const fetchFromGitHub: KcovrSourceFetcher = {
  file: fetchRawFile,
  gitlink: (_repo, _path, revision) => fetchGitlink(revision),
};

export function main(
  argv: readonly string[],
  out: (text: string) => void,
  err: (text: string) => void,
  now: Clock = () => Date.now(),
  fetcher: KcovrSourceFetcher = fetchFromGitHub,
): Promise<number> {
  const [command, ...args] = argv;

  if (command === undefined) {
    err(`${USAGE}\n`);
    return Promise.resolve(2);
  }
  if (command === "--help" || command === "-h" || command === "help") {
    out(`${USAGE}\n`);
    return Promise.resolve(0);
  }
  if (command === "report") return mainReport(args, out, err, now);
  if (command === "hits") return mainHits(args, out, err);
  if (command === "rules") return mainRules(args, out, err);
  if (command === "translate") return mainTranslate(args, out, err);
  if (command === "kore-log") return mainKoreLog(args, out, err);
  if (command === "check-k") return mainCheckK(args, out, err, fetcher);

  err(`unknown command: ${command}\n\n${USAGE}\n`);
  return Promise.resolve(2);
}

//////////////////////////////
// report                   //
//////////////////////////////

/**
 * `parse_args` (`kcovr.py:58-73`), split at the first `++` **or** `--`.
 *
 * Flags are only recognised before the separator: everything after it is a
 * path, so a source file called `--timestamp` is a source file.
 */
function splitAtSeparator(args: readonly string[]): {
  readonly before: readonly string[];
  readonly after: readonly string[];
  readonly separator: string | undefined;
} {
  const index = args.findIndex((arg) => arg === "++" || arg === "--");
  if (index === -1) return { before: args, after: [], separator: undefined };
  return { before: args.slice(0, index), after: args.slice(index + 1), separator: args[index] };
}

async function mainReport(
  args: readonly string[],
  out: (text: string) => void,
  err: (text: string) => void,
  now: Clock,
): Promise<number> {
  const { before, after, separator } = splitAtSeparator(args);

  const dirs: string[] = [];
  let timestamp: number | undefined;
  for (let i = 0; i < before.length; i += 1) {
    const arg = before[i] ?? "";
    if (arg === "--timestamp") {
      const value = before[i + 1];
      i += 1;
      if (value === undefined || !/^\d+$/u.test(value)) {
        err(`--timestamp takes a whole number of seconds since the epoch\n\n${USAGE}\n`);
        return 2;
      }
      timestamp = Number(value);
    } else if (arg.startsWith("-")) {
      err(`unknown option: ${arg}\n\n${USAGE}\n`);
      return 2;
    } else {
      dirs.push(arg);
    }
  }

  if (separator === undefined || dirs.length === 0 || after.length === 0) {
    err(`report takes <definition-dir>... ++ <source-file>...\n\n${USAGE}\n`);
    return 2;
  }

  const options: CoverageOptions = { timestamp: timestamp ?? Math.floor(now() / 1000) };
  const sources = after.map((source) => resolveSourcePath(source));

  try {
    const definitions = await readCoverageDefinitions(dirs);
    const report = renderCoverageReport(definitions, sources, options);
    if (report.unknownIds.length > 0) err(unknownIdWarning(report.unknownIds));
    out(report.xml);
    return 0;
  } catch (error) {
    err(`${messageOf(error)}\n`);
    return 1;
  }
}

/**
 * What to say about hit ids no `allRules.txt` knows.  pyk dies with a bare
 * `KeyError` here (`kcovr.py:253-255`); the ids are excluded from the rates and
 * this goes to stderr, so the XML on stdout is still pipeable.
 */
function unknownIdWarning(unknownIds: readonly string[]): string {
  const shown = unknownIds.slice(0, 3).join(", ");
  const rest = unknownIds.length > 3 ? `, … (${unknownIds.length - 3} more)` : "";
  return (
    `warning: ${unknownIds.length} rule id${unknownIds.length === 1 ? "" : "s"} in the hit logs ` +
    `${unknownIds.length === 1 ? "is" : "are"} not in allRules.txt and ${unknownIds.length === 1 ? "was" : "were"} ` +
    `excluded from the rates: ${shown}${rest}\n` +
    "  Hit logs are append-only (io.cpp:552), so this usually means they predate the last kompile. " +
    "Delete *_coverage.txt and re-run.\n"
  );
}

//////////////////////////////
// hits                     //
//////////////////////////////

async function mainHits(
  args: readonly string[],
  out: (text: string) => void,
  err: (text: string) => void,
): Promise<number> {
  const [dir, ...rest] = args;
  if (dir === undefined || rest.length > 0) {
    err(`hits takes exactly one definition directory\n\n${USAGE}\n`);
    return 2;
  }

  try {
    const definitions = await readCoverageDefinitions([dir]);
    // No source filter: `hits` reports the directory, not a scoped report.
    const ruleMap = createRuleMap(definitions);
    const coverMap = createCoverMap(definitions.flatMap((definition) => definition.coverageLogs));

    let unknown = 0;
    const lines: string[] = [];
    for (const ruleId of [...coverMap.keys()].toSorted()) {
      const location = ruleMap.get(ruleId);
      if (location === undefined) unknown += 1;
      // A tab-separated line stays greppable and `sort`able; `?` marks a
      // location `allRules.txt` cannot supply rather than leaving a ragged row.
      lines.push(`${ruleId}\t${coverMap.get(ruleId) ?? 0}\t${location?.location ?? "?"}`);
    }
    out(lines.length === 0 ? "" : `${lines.join("\n")}\n`);

    if (unknown > 0) {
      err(
        `warning: ${unknown} of ${coverMap.size} rule ids are not in allRules.txt (shown with location "?"); ` +
          "the hit logs probably predate the last kompile\n",
      );
    }
    return 0;
  } catch (error) {
    err(`${messageOf(error)}\n`);
    return 1;
  }
}

//////////////////////////////
// rules                    //
//////////////////////////////

/**
 * `exec_coverage` (`__main__.py:403-413`), line for line.
 *
 * The one remaining deviation is in the module header; the block shape is
 * upstream's exactly — a blank line, `Rule: <id>`, `Unparsed:`, then the rule.
 */
async function mainRules(
  args: readonly string[],
  out: (text: string) => void,
  err: (text: string) => void,
): Promise<number> {
  const [dir, coverageFile, ...rest] = args;
  if (dir === undefined || coverageFile === undefined || rest.length > 0) {
    err(`rules takes a definition directory and a coverage file\n\n${USAGE}\n`);
    return 2;
  }

  try {
    const [raw, coverageText] = await Promise.all([readKompiledJsonDefinition(dir), readTextFile(coverageFile)]);
    // `:405` — the whole definition loses `Source`/`Location` before anything
    // reads it, so neither the printer's symbol table nor the printed sentences
    // carry the build machine's absolute paths.
    const definition = removeSourceMap(raw);
    const printer = new PrettyPrinter(definition);

    const blocks: string[] = [];
    for (const ruleId of hitIds(coverageText)) {
      // `minimize_rule_like(strip_coverage_logger(get_rule_by_id(...)))` (`:407`).
      const rule = minimizeRuleLike(stripCoverageLogger(getRuleById(definition, ruleId)));
      blocks.push(`\n\nRule: ${ruleId}\nUnparsed:\n${printer.print(rule)}`);
    }

    if (blocks.length === 0) {
      err(`no rule ids in ${coverageFile}\n`);
      return 0;
    }
    // One trailing newline, so the stream is line-terminated; see the header.
    out(`${blocks.join("")}\n`);
    return 0;
  } catch (error) {
    err(`${messageOf(error)}\n`);
    return 1;
  }
}

/**
 * The ids in a hit log, in order, duplicates kept — `for rid in
 * options.coverage_file` (`__main__.py:406`) with pyk's `rid.strip()` and the
 * blank-line skip `hits.ts` explains.
 */
function hitIds(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

//////////////////////////////
// translate                //
//////////////////////////////

/**
 * `translate_coverage_from_paths` (`coverage.py:108-133`) as a command.
 *
 * Upstream exposes this through no entry point at all — it is a library
 * function with no caller — so the output format is this package's: one dst id
 * per line, in log order, duplicates kept, so that piping it into
 * `createCoverMap` gives the destination's application counts.
 */
async function mainTranslate(
  args: readonly string[],
  out: (text: string) => void,
  err: (text: string) => void,
): Promise<number> {
  const [srcDir, dstDir, coverageFile, ...rest] = args;
  if (srcDir === undefined || dstDir === undefined || coverageFile === undefined || rest.length > 0) {
    err(`translate takes <src-def-dir> <dst-def-dir> <coverage-file>\n\n${USAGE}\n`);
    return 2;
  }

  try {
    const translated = await translateCoverageFromPaths(srcDir, dstDir, coverageFile);
    out(translated.length === 0 ? "" : `${translated.join("\n")}\n`);
    return 0;
  } catch (error) {
    err(`${messageOf(error)}\n`);
    return 1;
  }
}

//////////////////////////////
// kore-log                 //
//////////////////////////////

/**
 * `kore-exec-covr`'s `main` (`kore_exec_covr/__main__.py:77-97`).
 *
 * The flag is spelled `--definition-dir` upstream; `--definition` is accepted
 * too, because that is what every other command in this monorepo calls it and
 * the plan's CLI table (§2) uses the short spelling.  `--quiet` is upstream's
 * (`:94`) and does here what it does there: silences the warnings, not the
 * report.
 */
async function mainKoreLog(
  args: readonly string[],
  out: (text: string) => void,
  err: (text: string) => void,
): Promise<number> {
  let definitionDir: string | undefined;
  let quiet = false;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === "--definition" || arg === "--definition-dir") {
      definitionDir = args[i + 1];
      i += 1;
      if (definitionDir === undefined) {
        err(`${arg} takes a kompiled definition directory\n\n${USAGE}\n`);
        return 2;
      }
    } else if (arg === "--quiet" || arg === "-q") {
      quiet = true;
    } else if (arg.startsWith("-")) {
      err(`unknown option: ${arg}\n\n${USAGE}\n`);
      return 2;
    } else {
      positional.push(arg);
    }
  }

  const [logFile, ...rest] = positional;
  if (logFile === undefined || definitionDir === undefined || rest.length > 0) {
    err(`kore-log takes one log file and --definition <dir>\n\n${USAGE}\n`);
    return 2;
  }

  try {
    const [definition, logText] = await Promise.all([readKompiledJsonDefinition(definitionDir), readTextFile(logFile)]);
    const report = renderKoreExecReport(definition, logText, { definitionDir });
    out(report.text);
    // pyk's `_LOGGER.warning` goes to stderr through `logging`; so does this,
    // and `--quiet` (`:80-82`, which raises the level to ERROR) drops it.
    if (!quiet) for (const warning of report.warnings) err(`warning: ${warning}\n`);
    return 0;
  } catch (error) {
    err(`${messageOf(error)}\n`);
    return 1;
  }
}

//////////////////////////////
// check-k                  //
//////////////////////////////

/** The two tiers, with the sentence each one's verdict has to be read under. */
const TIER_HEADINGS: Readonly<Record<KcovrSourceTier, string>> = {
  transcription: "transcription tier (the pyk modules this package ports):",
  reference: "reference tier (checked against, not ported — and NOT advisory: see the footer):",
};

function summaryFor(verdict: KcovrSourcesVerdict, what: string): string {
  return verdict === "unchanged"
    ? `${what}: unchanged — this package is current there.`
    : verdict === "changed"
      ? `${what}: CHANGED — diff the files above before trusting this package at that release.`
      : `${what}: could not locate a path — the check cannot answer; the manifest needs re-establishing.`;
}

export function render(report: KcovrSourcesReport): string {
  const tierOf = (tier: KcovrSourceTier): string =>
    report.files
      .filter((file) => file.tier === tier)
      .map((file) => {
        const mark = file.status === "unchanged" ? "ok  " : file.status === "changed" ? "DIFF" : "GONE";
        const detail =
          file.status === "unchanged"
            ? `unchanged since ${report.recordedAt}`
            : file.status === "changed"
              ? `expected ${file.expected.slice(0, 12)}…, got ${(file.actual ?? "").slice(0, 12)}…`
              : `no such path at ${report.release}`;
        const identity = `${file.repo}@${file.revision || "unresolved"}`;
        const resolved =
          file.resolvedFrom === undefined
            ? ""
            : `\n        resolved through ${file.resolvedFrom.repo}@${file.resolvedFrom.release}:${file.resolvedFrom.path}` +
              (file.resolvedFrom.commit === undefined ? " (missing gitlink)" : `@${file.resolvedFrom.commit}`);
        return `  ${mark}  ${identity}/${file.path}\n        ${detail}${resolved}\n        ${file.why}`;
      })
      .join("\n");

  return (
    `${TIER_HEADINGS.transcription}\n${tierOf("transcription")}\n\n` +
    `${TIER_HEADINGS.reference}\n${tierOf("reference")}\n\n` +
    `${summaryFor(report.verdicts.transcription, "transcription")}\n` +
    `${summaryFor(report.verdicts.reference, "reference")}\n\n` +
    // Every sibling downgrades its second tier to advice.  This one cannot:
    // one of the two files *is* the specification of the format
    // `koreExecLog.ts` reads, and the other decides the shape
    // `stripCoverageLogger` strips.  There is no other authority to consult.
    "Both tiers gate the exit code, unlike this package's siblings: upstream has no test and no\n" +
    "specification for any of this, so the reference tier is the only specification there is.\n"
  );
}

/**
 * The exit code, over **both** tiers.
 *
 * `changed` outranks `could-not-locate` for the reason `ksources.ts` gives per
 * tier: a demonstrable diff is a finding, a missing path only an inconclusive
 * one.
 */
export function exitCodeFor(verdicts: KcovrSourcesReport["verdicts"]): number {
  const changed = verdicts.transcription === "changed" || verdicts.reference === "changed";
  const missing = verdicts.transcription === "could-not-locate" || verdicts.reference === "could-not-locate";
  return changed ? 1 : missing ? 3 : 0;
}

async function mainCheckK(
  args: readonly string[],
  out: (text: string) => void,
  err: (text: string) => void,
  fetcher: KcovrSourceFetcher,
): Promise<number> {
  const [release, ...rest] = args;
  if (release === undefined || rest.length > 0) {
    err(`check-k takes a K release tag (e.g. ${K_RELEASE})\n\n${USAGE}\n`);
    return 2;
  }

  let report: KcovrSourcesReport;
  try {
    report = await checkKcovrSources(release, fetcher);
  } catch (error) {
    // Failing to reach GitHub is "could not ask", which is neither a pass nor a
    // fail — reporting it as either would be a lie about upstream.
    err(`could not check ${release}: ${messageOf(error)}\n`);
    return 2;
  }

  out(render(report));
  return exitCodeFor(report.verdicts);
}

/** A `KcovrError` already says what to do; anything else offers its own text. */
function messageOf(error: unknown): string {
  return error instanceof KcovrError || error instanceof Error ? error.message : String(error);
}
