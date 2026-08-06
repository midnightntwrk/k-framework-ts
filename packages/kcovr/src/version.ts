/**
 * Identity of this transcription: which upstream files, at which release, with
 * which hashes — the same contract `packages/kompiled/src/version.ts`,
 * `packages/kore/src/version.ts` and `packages/kast-json/src/version.ts` carry.
 *
 * K's rule coverage has no specification at all.  There is no schema, no
 * documented grammar, and — uniquely among the formats this monorepo reads —
 * **no upstream test that exercises any of it**: `kcovr.py`, `coverage.py` and
 * `kprint.all_rules` have no test whatsoever, and the three
 * `regression-new/` directories that pass `--coverage` (duplicated across
 * `pyk/` and `k-distribution/`, so six `Makefile`s) assert only that
 * `kompile --coverage` exits 0 — none of them contains a `.test` program, so
 * `krun` never runs and no coverage output is ever produced, let alone diffed.
 * The pyk implementation is therefore the specification, which is why the
 * manifest below hashes the implementation rather than a document.
 *
 * Two of the six entries are **behavioural references**, not transcriptions —
 * see {@link KcovrSourceTier}.
 */

/** The K release every source below was read at. */
export const K_RELEASE = "v7.1.337";

/**
 * The commit `v7.1.337` points at, recorded so a checkout can be identified
 * when the tag is not available.
 */
export const K_COMMIT = "4a46d1231473b599c699160132fd6e76a5c46406";

/**
 * Identity of `io.cpp`, which is **not** in {@link TRANSCRIBED_FROM} and is
 * checked by nothing.
 *
 * `io.cpp:526-572` is the authority for where a hit log lands and what it is
 * called — `<K_LOG_DIR | dirname(path)>/<K_LOG_PREFIX><pid>_coverage.txt`
 * (`:539-552`), opened in append mode (`"a+"`, `:552`) and flushed at `atexit`
 * (`:566`) — and it implements the `#logToFile` hook (`:560`).  It
 * cannot join the manifest because it lives in the `llvm-backend` **submodule**,
 * and `checkKcovrSources`' fetch-from-`runtimeverification/k`-at-tag mechanism
 * cannot reach a submodule's tree.  Its identity at the release
 * `runtimeverification/k` `v7.1.337` pins is recorded here instead, honestly
 * labelled as unchecked.
 *
 * @see https://github.com/runtimeverification/llvm-backend
 */
export const IO_CPP_IDENTITY = {
  repo: "runtimeverification/llvm-backend",
  path: "runtime/io/io.cpp",
  lines: 786,
  sha256: "977b8238f8303163191a90512139974d4ccb5d4793b1db3ee6049379f22617c9",
  why: "hit-log filename grammar (:539-551), append mode (:552), atexit flush (:566), the #logToFile hook (:560)",
  checkedBy: "nothing — submodule, unreachable from the k-repo-at-tag fetcher",
} as const;

/** The repository a transcription source lives in. */
export type KcovrSourceRepo = "runtimeverification/k";

/**
 * The two drift tiers, hashed separately because a diff in each means a
 * different thing:
 *
 * - `transcription` — the four pyk modules this package's behaviour is a
 *   line-by-line port of.  A change here means the port itself must be
 *   re-verified against the new source.
 * - `reference` — files this package is checked *against* rather than ported
 *   from: the frozen unit-test table that is the only specification the legacy
 *   haskell-log format has, and the Java pass that decides the instrumented
 *   rule shape `stripCoverageLogger` must strip.  Nothing here is transcribed,
 *   but a change to either invalidates this package's answers, so a diff is a
 *   real finding and not merely advisory.
 */
export type KcovrSourceTier = "transcription" | "reference";

export interface KcovrTranscribedSource {
  readonly repo: KcovrSourceRepo;
  /** Path within that repository's tree. */
  readonly path: string;
  /** Line count at {@link K_RELEASE}. */
  readonly lines: number;
  /** Lowercase hex sha256 of the file at {@link K_RELEASE}. */
  readonly sha256: string;
  readonly tier: KcovrSourceTier;
  /** Why this file is in the manifest. */
  readonly why: string;
}

/**
 * Every upstream file this package is derived from or checked against.
 *
 * Three format authorities are deliberately absent.  `Kompile.java:363-382`
 * writes `allRules.txt`, but this package does not parse it — it routes every
 * read through `@kframework-ts/kompiled`'s `parseAllRules`, whose own manifest
 * already pins that file, and duplicating the hash here would create two places
 * to update.  `io.cpp` is absent for the mechanical reason in
 * {@link IO_CPP_IDENTITY}.  `pyk/src/pyk/__main__.py` is absent by judgement:
 * `exec_coverage` (`:403-413`) is what `kcovr rules` is parity with, but that
 * file is pyk's whole CLI — every unrelated subcommand churns it — and both
 * tiers here decide the exit code, so pinning it would turn `check-k` into a
 * noise generator.  The two library functions `exec_coverage` composes
 * (`minimize_rule_like`, `remove_source_map`) live in `kast/manip.py`, which
 * `@kframework-ts/kast`'s own manifest pins.
 */
export const TRANSCRIBED_FROM: readonly KcovrTranscribedSource[] = [
  // --- transcription tier: the pyk modules this package ports --------------
  {
    repo: "runtimeverification/k",
    path: "pyk/src/pyk/kcovr.py",
    lines: 264,
    sha256: "a981ca48967e5de4550d5a916fbc892a13227892ea350e74ddbc359cfaa755c3",
    tier: "transcription",
    why: "create_cover_map (:197-217) — hit counting; render_coverage_xml (:76-175) and the Cobertura templates (:16-49); create_rule_map (:178-194); the `pyk-covr` entry point's `++` argument split (:65)",
  },
  {
    repo: "runtimeverification/k",
    path: "pyk/src/pyk/coverage.py",
    lines: 133,
    sha256: "b3acd449b58d0e9cbb24785608a4920934db37583a44779eabeedee5404ca182",
    tier: "transcription",
    why: "translate_coverage (:46-105) and its <generatedTop> filter (:80-89); get_rule_by_id (:16-31); strip_coverage_logger (:34-43); the file-level wrappers (:108-133)",
  },
  {
    repo: "runtimeverification/k",
    path: "pyk/src/pyk/kore_exec_covr/kore_exec_covr.py",
    lines: 107,
    sha256: "c4cf9587e91d7627be41fc611dc7c973654efa336756bf792e70a0cd76cce607",
    tier: "transcription",
    why: "the legacy haskell-oneline analyzer: the log regex (:21), parse_rule_applications (:29-63), parse_rule_application (:66-75), build_rule_dict (:78-102), HaskellLogEntry (:24-26)",
  },
  {
    repo: "runtimeverification/k",
    path: "pyk/src/pyk/kore_exec_covr/__main__.py",
    lines: 101,
    sha256: "4c0f104ae4da529515da6fd269aadd12dca104ce7cf19653ade1ca6fd0ac4f2f",
    tier: "transcription",
    why: "the `kore-exec-covr` report format (:22-74) — section headers, counts, labels, and the `availible` typo that is part of the output contract",
  },

  // --- reference tier: checked against, not ported -------------------------
  {
    repo: "runtimeverification/k",
    path: "pyk/src/tests/unit/test_kore_exec_covr.py",
    lines: 100,
    sha256: "776d9cc14c402f796446a1710d8a588c14285a5681e6b9d29e555bcf565844e0",
    tier: "reference",
    why: "the only test upstream has for any of this — 7 inline cases (:13-42) that are the *specification* of the legacy log format, since the current haskell-backend no longer emits it and no fixture can be regenerated",
  },
  {
    repo: "runtimeverification/k",
    path: "k-frontend/src/main/java/org/kframework/compile/GenerateCoverage.java",
    lines: 80,
    sha256: "478a41ff74b523afaab7d9c72f56007e8fe9a2625e7f7218e3b2016fbf751751",
    tier: "reference",
    why: 'defines the instrumented rule shape stripCoverageLogger must strip — `sideEffect:<Sort>(#logToFile(<path>, <uid> + "\\n"), <rhs>)` (:66-78) — which is not what pyk\'s stale strip_coverage_logger matches',
  },
];
