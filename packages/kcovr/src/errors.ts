/**
 * The error contract.
 *
 * pyk's coverage code has essentially no error handling: it uses a bare
 * `assert` for the one invariant it checks (`kcovr.py:193`), `ValueError` with
 * a hand-written message for the two translation failures
 * (`coverage.py:96,100`), and an unguarded `KeyError` / `ZeroDivisionError` for
 * everything else.  Three of those conditions are *diagnosable input problems*
 * — a caller can act on them — so this package names them:
 *
 * | condition                                    | pyk                                     | here                            |
 * | -------------------------------------------- | --------------------------------------- | ------------------------------- |
 * | one `UNIQUE_ID`, two locations               | `assert len(all_rules) == len(rule_map)` | {@link DuplicateRuleIdError}    |
 * | hit id absent from `allRules.txt`            | `KeyError` (`kcovr.py:253-255`)         | `unknownIds` diagnostic, no throw |
 * | zero rules in the requested sources          | `ZeroDivisionError` (`kcovr.py:86,90`)  | rate renders as `1.0`, no throw |
 *
 * Only the first is an error, because only the first means the *inputs* are
 * contradictory: two different rules cannot share a SHA3-256 identity, so an
 * `allRules.txt` that says they do was built from mismatched definitions and
 * every number downstream of it would be a guess.  The other two are ordinary
 * states of a real build — recompile between run and report, or a report scoped
 * to a source file with no rules in it — and answering them with a crash is
 * what makes pyk's renderer unusable on anything but a freshly-built tree.
 *
 * The three `coverage.py` conditions are different: pyk raises a `ValueError`
 * with a hand-written message for each, so there is wording to keep, and plan
 * §4 items 6 and 7 say to keep it.  {@link RuleNotFoundError},
 * {@link UnknownSourceRuleError} and {@link UnknownTargetLocationError} each
 * carry pyk's sentence as the **first line** of `message`, byte-for-byte, and
 * add a second line saying what to do about it — the same shape
 * {@link MissingCoverageFileError} uses, and the reason every test that pins the
 * wording compares the first line rather than the whole string.
 *
 * Every class here sets `name` explicitly: `instanceof` across two installed
 * copies of a package is unreliable, `name` is not.
 */

/* oxlint-disable max-classes-per-file -- six: the base every caller catches,
   and the five conditions it distinguishes. Splitting them would put a subclass
   in a different file from its parent. */

/** Base class for every diagnosable coverage-input failure. */
export class KcovrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KcovrError";
  }
}

/**
 * The same `UNIQUE_ID` appears at two different locations across the
 * `allRules.txt` files being reported on.
 *
 * pyk checks this — `assert len(all_rules) == len(rule_map)` (`kcovr.py:193`),
 * comparing the size of the set of whole *lines* against the size of the map
 * keyed by id — and then dies with a bare `AssertionError` naming neither the
 * id nor either location, in a process the user did not start under `-O`.
 * Identical lines from two definition directories collapse in that set and are
 * fine here too; it is only a genuine conflict that throws.
 *
 * The message names all three things needed to act: which id, and both places
 * that claim it.  A real occurrence means two definition directories were built
 * from different sources — the id is SHA3-256 of the normalized sentence
 * (`NumberSentences.java:26-54`), so a collision is not a hash collision, it is
 * a stale directory.
 */
export class DuplicateRuleIdError extends KcovrError {
  /** The `UNIQUE_ID` claimed twice. */
  readonly ruleId: string;
  /** The location already recorded for it, as written in `allRules.txt`. */
  readonly first: string;
  /** The conflicting location. */
  readonly second: string;

  constructor(ruleId: string, first: string, second: string) {
    super(
      `Duplicate UNIQUE_ID ${ruleId} in allRules.txt: ${first} and ${second}.\n` +
        "A rule id is SHA3-256 of the normalized sentence (NumberSentences.java:26-54), so this is not a hash " +
        "collision — the definition directories being reported on were built from different sources.",
    );
    this.name = "DuplicateRuleIdError";
    this.ruleId = ruleId;
    this.first = first;
    this.second = second;
  }
}

/**
 * A file this package needs is not in the definition directory.
 *
 * Only `allRules.txt` can raise it.  `coverage.txt` and the `*_coverage.txt`
 * logs are all optional here — see `fs.ts` — because a macro-free semantics
 * writes an *empty* macro log and a definition that has never been run writes
 * no hit log at all, and neither is a mistake.  Without `allRules.txt` there is
 * nothing to report against, so that one throws.
 */
export class MissingCoverageFileError extends KcovrError {
  /** The directory that was read. */
  readonly dir: string;
  /** The file that was missing from it. */
  readonly file: string;

  constructor(dir: string, file: string, hint: string) {
    super(`Missing ${file} in definition directory: ${dir}\n${hint}`);
    this.name = "MissingCoverageFileError";
    this.dir = dir;
    this.file = file;
  }
}

/** A directory supplied as `K_LOG_DIR` is unsafe for LLVM coverage output. */
export class CoverageLogDirError extends KcovrError {
  readonly dir: string;
  readonly reason: "missing" | "not-directory" | "unwritable";
  override readonly cause?: unknown;

  constructor(dir: string, reason: "missing" | "not-directory" | "unwritable", cause?: unknown) {
    super(
      reason === "missing"
        ? `Coverage-log directory does not exist: ${dir}`
        : reason === "not-directory"
          ? `Coverage-log path is not a directory: ${dir}`
          : `Coverage-log directory is not writable: ${dir}`,
    );
    this.name = "CoverageLogDirError";
    this.dir = dir;
    this.reason = reason;
    this.cause = cause;
  }
}

/**
 * No rule in the definition carries the requested `UNIQUE_ID` —
 * `get_rule_by_id`'s `ValueError` (`coverage.py:31`).
 *
 * The usual cause is not a typo but a **stale hit log**: the logs are
 * append-only (`io.cpp:552`), so ids from a previous build survive a recompile
 * and then name a rule absent from the loaded definition.  The second cause is a definition
 * directory compiled without `--emit-json`, whose `compiled.json` is absent or
 * belongs to a different build than its `allRules.txt`.
 */
export class RuleNotFoundError extends KcovrError {
  /** The id that was looked up. */
  readonly ruleId: string;

  constructor(ruleId: string) {
    super(
      // `coverage.py:31`, verbatim.
      `Could not find rule with ID: ${ruleId}\n` +
        "Hit logs are append-only (io.cpp:552), so an id from an earlier build outlives a recompile. Check that " +
        "compiled.json and the hit log come from the same kompile, and delete *_coverage.txt before re-running.",
    );
    this.name = "RuleNotFoundError";
    this.ruleId = ruleId;
  }
}

/**
 * A hit names a rule the **source** build's `allRules.txt` does not contain —
 * `translate_coverage`'s first `ValueError` (`coverage.py:95`).
 *
 * Translation cannot degrade gracefully here the way the report's
 * `unknownIds` diagnostic does: a report can drop an unknown id and still be a
 * report, but a translated hit *list* with holes in it silently understates the
 * destination's coverage, and nothing downstream could tell.  So this throws,
 * as upstream throws.
 */
export class UnknownSourceRuleError extends KcovrError {
  /** The hit id with no entry in the source `allRules.txt`. */
  readonly ruleId: string;

  constructor(ruleId: string) {
    super(
      // `coverage.py:95`, verbatim — including pyk's internal variable name,
      // which is the only identifier a user searching for this message has.
      `Could not find rule in src_rule_map: ${ruleId}\n` +
        "The hit log and the source allRules.txt are from different builds. Hit logs are append-only " +
        "(io.cpp:552): delete *_coverage.txt and re-run against the build you are translating from.",
    );
    this.name = "UnknownSourceRuleError";
    this.ruleId = ruleId;
  }
}

/**
 * A source rule's location has no counterpart in the **destination** build —
 * `translate_coverage`'s second `ValueError` (`coverage.py:99`).
 *
 * The key is `basename:line:col`, so this fires whenever the rule moved within
 * its file, not only when the file itself is gone.  Translation is a *rename*
 * tool: it maps hits across a recompile of the same sources, and a genuine edit
 * to a rule's text invalidates the mapping by design.
 */
export class UnknownTargetLocationError extends KcovrError {
  /** The `basename:line:col` key that was looked up. */
  readonly location: string;
  /** The source-build rule id that key came from. */
  readonly ruleId: string;

  constructor(location: string, ruleId: string) {
    super(
      // `coverage.py:99`, verbatim.
      `Could not find rule location in dst_rule_map: ${location}\n` +
        `It is where the source build puts rule ${ruleId}. Rules are matched by basename:line:col, so an edit ` +
        "that moved this rule — not only a deleted file — breaks the mapping.",
    );
    this.name = "UnknownTargetLocationError";
    this.location = location;
    this.ruleId = ruleId;
  }
}
