/**
 * Answering "does this transcription still hold at K release vX?" — the same
 * question `packages/kompiled`, `packages/kast`, `packages/kast-json` and
 * `packages/kore` answer, asked about a different set of files.
 *
 * The logic is pure and takes its fetcher as an argument, so it runs offline in
 * tests; `cli.ts` supplies one that talks to GitHub.
 *
 * # What is different here
 *
 * One repository — `runtimeverification/k` — so no per-repo release resolution,
 * unlike `packages/kore`.  But the tier split does not mean what it means in
 * the siblings, and the difference is the point.
 *
 * Elsewhere the second tier is *advisory*: in `kompiled` it is the Java files
 * that decide a directory layout which K itself says is "subject to change
 * without warning", so a diff is a warning rather than a verdict.  Here the
 * second tier is `reference`, and a diff in it is a **real finding**:
 *
 * - `test_kore_exec_covr.py` is not a test of a format that exists elsewhere —
 *   it *is* the format.  The current haskell-backend no longer prints source
 *   locations in oneline mode (`DebugAppliedRewriteRules.hs:69-73` now prints
 *   `"applied N rewrite rules"`), so no fixture can be regenerated and no other
 *   authority can be consulted.  If that table changes, the only specification
 *   `koreExecLog.ts` has changed with it.
 * - `GenerateCoverage.java` decides the shape of the instrumentation
 *   `stripCoverageLogger` strips.  If it changes, this package is stripping the
 *   wrong thing — which is precisely the failure pyk is in today, having never
 *   updated `coverage.py:34-43` after the `sideEffect` rework.
 *
 * So both verdicts gate trust.  Neither is downgraded to a warning.
 *
 * # What this check does not cover
 *
 * `io.cpp` — see `version.ts`'s `IO_CPP_IDENTITY`.  It lives in the
 * `llvm-backend` submodule, which fetching from `runtimeverification/k` at a tag
 * cannot reach, so its hash is recorded and checked by nothing.  And
 * `allRules.txt`'s producer, `Kompile.java`, is pinned by
 * `@kframework-ts/kompiled`'s manifest instead of duplicated here: this package
 * does not parse that file, it delegates.
 */

import {
  K_RELEASE,
  TRANSCRIBED_FROM,
  type KcovrSourceRepo,
  type KcovrSourceTier,
  type KcovrTranscribedSource,
} from "./version.js";

/** What a single declared file turned out to be at the requested release. */
export type KcovrSourceStatus = "unchanged" | "changed" | "missing";

export interface KcovrSourceOutcome {
  readonly repo: KcovrSourceRepo;
  readonly path: string;
  readonly tier: KcovrSourceTier;
  readonly status: KcovrSourceStatus;
  /** The sha256 recorded in this package. */
  readonly expected: string;
  /** The sha256 observed at the requested release; absent when `missing`. */
  readonly actual?: string;
  /** Why the file is in the manifest — carried through so a report is readable. */
  readonly why: string;
}

/**
 * A per-tier answer.  Three-valued, never boolean:
 *
 * - `unchanged` — every declared file in the tier is byte-identical.
 * - `changed` — at least one differs.  A human must diff it.
 * - `could-not-locate` — nothing differed, but at least one path is gone; the
 *   check has stopped being able to answer, which is not a verdict.
 *
 * `changed` outranks `could-not-locate`: a demonstrable diff is a definite
 * finding, a missing path only an inconclusive one.
 */
export type KcovrSourcesVerdict = "unchanged" | "changed" | "could-not-locate";

export interface KcovrSourcesReport {
  /** The K release the question was asked about. */
  readonly release: string;
  /** The K release the recorded hashes were taken at. */
  readonly recordedAt: string;
  /**
   * Per-tier verdicts.  Unlike the siblings, **both** gate trust — see the
   * module header for why `reference` is not advisory here.
   */
  readonly verdicts: Readonly<Record<KcovrSourceTier, KcovrSourcesVerdict>>;
  readonly files: readonly KcovrSourceOutcome[];
}

/**
 * Fetches one file from one repository at one release.  Returns `undefined`
 * when the path does not exist at that tag — which must be distinguished from a
 * network failure, so an implementation should throw for anything that is not a
 * clean 404.
 */
export type KcovrSourceFetcher = (
  repo: KcovrSourceRepo,
  path: string,
  release: string,
) => Promise<Uint8Array | undefined>;

/**
 * Web Crypto, reached through `globalThis` rather than named directly — the
 * same mechanism, and the same reason, as `packages/kompiled/src/ksources.ts`.
 */
interface SubtleLike {
  digest(algorithm: string, data: ArrayBuffer): Promise<ArrayBuffer>;
}

/** Lowercase hex sha256 of `bytes`, via Web Crypto — no Node-only imports. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const { crypto } = globalThis as unknown as { crypto: { subtle: SubtleLike } };
  // A Uint8Array may be a view onto a larger buffer, so hash the exact window.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const view = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", view);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function verdictOf(files: readonly KcovrSourceOutcome[], tier: KcovrSourceTier): KcovrSourcesVerdict {
  const inTier = files.filter((f) => f.tier === tier);
  return inTier.some((f) => f.status === "changed")
    ? "changed"
    : inTier.some((f) => f.status === "missing")
      ? "could-not-locate"
      : "unchanged";
}

/**
 * Compare every declared file against its counterpart at `release`.
 *
 * Throws whatever `fetcher` throws: a network failure is not a verdict, and
 * reporting one as `missing` would turn "I could not ask" into "upstream moved
 * it".
 */
export async function checkKcovrSources(
  release: string,
  fetcher: KcovrSourceFetcher,
  sources: readonly KcovrTranscribedSource[] = TRANSCRIBED_FROM,
  recordedAt: string = K_RELEASE,
): Promise<KcovrSourcesReport> {
  const files: KcovrSourceOutcome[] = await Promise.all(
    sources.map(async (source): Promise<KcovrSourceOutcome> => {
      const bytes = await fetcher(source.repo, source.path, release);
      if (bytes === undefined) {
        return {
          repo: source.repo,
          path: source.path,
          tier: source.tier,
          status: "missing",
          expected: source.sha256,
          why: source.why,
        };
      }
      const actual = await sha256Hex(bytes);
      return {
        repo: source.repo,
        path: source.path,
        tier: source.tier,
        status: actual === source.sha256 ? "unchanged" : "changed",
        expected: source.sha256,
        actual,
        why: source.why,
      };
    }),
  );

  return {
    release,
    recordedAt,
    verdicts: {
      transcription: verdictOf(files, "transcription"),
      reference: verdictOf(files, "reference"),
    },
    files,
  };
}
