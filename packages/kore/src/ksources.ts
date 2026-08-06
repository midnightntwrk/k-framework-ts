/**
 * Answering "does this transcription still hold at K release vX?" — for any
 * `vX`, including releases published after this package was.
 *
 * Same design as kast-json's `ksources.ts` (see that file and
 * `docs/versioning.md` for the argument), with two structural differences
 * KORE forces:
 *
 * 1. **Two repositories.** The sources span `runtimeverification/k` and
 *    `runtimeverification/haskell-backend`, so the caller supplies a release
 *    *per repo* and the fetcher receives the repo alongside the path. The k
 *    repo itself records which haskell-backend commit a k tag pins (the
 *    submodule at `haskell-backend/src/main/native/haskell-backend`); a CLI
 *    can resolve that automatically, but this pure layer does not guess.
 * 2. **Two tiers.** `format` files define what KORE is; `content` is
 *    `ModuleToKORE.java`, which changes routinely without the format
 *    changing. They get separate verdicts so a content-only diff (advisory)
 *    is never conflated with a format diff (transcription must be
 *    re-verified). See `version.ts` for the tier rationale.
 *
 * The logic is pure and takes its fetcher as an argument, so it is tested
 * offline; the CLI supplies one that talks to GitHub.
 */

import {
  HASKELL_BACKEND_RELEASE,
  K_RELEASE,
  type KoreSourceRepo,
  type KoreSourceTier,
  type KoreTranscribedSource,
  TRANSCRIBED_FROM,
} from "./version.js";

/** What a single declared file turned out to be at the requested release. */
export type KoreSourceStatus = "unchanged" | "changed" | "missing";

export interface KoreSourceOutcome {
  readonly repo: KoreSourceRepo;
  readonly path: string;
  readonly tier: KoreSourceTier;
  readonly status: KoreSourceStatus;
  /** The sha256 recorded in this package. */
  readonly expected: string;
  /** The sha256 observed at the requested release; absent when `missing`. */
  readonly actual?: string;
}

/**
 * A per-tier answer. Three-valued, never boolean:
 *
 * - `unchanged` — every declared file in the tier is byte-identical.
 * - `changed` — at least one differs. A human must diff it.
 * - `could-not-locate` — nothing differed, but at least one path is gone;
 *   the check has stopped being able to answer, which is not a verdict.
 *
 * `changed` outranks `could-not-locate`: a demonstrable diff is a definite
 * finding, a missing path only an inconclusive one.
 */
export type KoreSourcesVerdict = "unchanged" | "changed" | "could-not-locate";

/** The releases a question is asked about — one per repository. */
export interface KoreReleases {
  /** Tag in `runtimeverification/k`, e.g. `"v7.1.337"`. */
  readonly k: string;
  /** Tag in `runtimeverification/haskell-backend`, e.g. `"v0.1.155"`. */
  readonly haskellBackend: string;
}

export interface KoreSourcesReport {
  /** The releases the question was asked about. */
  readonly releases: KoreReleases;
  /** The releases the recorded hashes were taken at. */
  readonly recordedAt: KoreReleases;
  /**
   * Per-tier verdicts. `format` is the one that gates trust in this package;
   * `content` drifting only means `kompile` may emit new attribute
   * vocabulary that a reader of `definition.kore` could care about.
   */
  readonly verdicts: Readonly<Record<KoreSourceTier, KoreSourcesVerdict>>;
  readonly files: readonly KoreSourceOutcome[];
}

/**
 * Fetches one file from one repository at one release. Returns `undefined`
 * when the path does not exist at that tag — which must be distinguished
 * from a network failure, so an implementation should throw for anything
 * that is not a clean 404.
 */
export type KoreSourceFetcher = (
  repo: KoreSourceRepo,
  path: string,
  release: string,
) => Promise<Uint8Array | undefined>;

/**
 * Web Crypto, reached through `globalThis` rather than named directly.
 *
 * The emit config sets `types: []` so the published `.d.ts` cannot make
 * consumers depend on `@types/bun`, which also means no ambient `crypto`.
 * Declaring one here would collide with Bun's under the development config,
 * so the global is narrowed by a cast instead: it type-checks under both,
 * and describes exactly the one method used.
 */
interface SubtleLike {
  digest(algorithm: string, data: ArrayBuffer): Promise<ArrayBuffer>;
}

/** Lowercase hex sha256 of `bytes`, via Web Crypto — no Node-only imports. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // The assertion is the mechanism described above, not an oversight: it is
  // how a global is reached without an ambient declaration that would collide
  // with Bun's. It narrows to the single method used, so it cannot mask a
  // real type.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const { crypto } = globalThis as unknown as { crypto: { subtle: SubtleLike } };
  // A Uint8Array may be a view onto a larger buffer, so hash the exact window
  // rather than everything the buffer happens to hold.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const view = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", view);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function verdictOf(files: readonly KoreSourceOutcome[], tier: KoreSourceTier): KoreSourcesVerdict {
  const inTier = files.filter((f) => f.tier === tier);
  return inTier.some((f) => f.status === "changed")
    ? "changed"
    : inTier.some((f) => f.status === "missing")
      ? "could-not-locate"
      : "unchanged";
}

/**
 * Compare every declared file against its counterpart at the requested
 * releases.
 *
 * Throws whatever `fetcher` throws: a network failure is not a verdict, and
 * reporting one as `missing` would turn "I could not ask" into "upstream
 * moved it".
 */
export async function checkKoreSources(
  releases: KoreReleases,
  fetcher: KoreSourceFetcher,
  sources: readonly KoreTranscribedSource[] = TRANSCRIBED_FROM,
  recordedAt: KoreReleases = { k: K_RELEASE, haskellBackend: HASKELL_BACKEND_RELEASE },
): Promise<KoreSourcesReport> {
  // Concurrent: these are independent network reads, and the declared order
  // is restored by `Promise.all` regardless of which returns first.
  const files: KoreSourceOutcome[] = await Promise.all(
    sources.map(async (source): Promise<KoreSourceOutcome> => {
      const release = source.repo === "runtimeverification/k" ? releases.k : releases.haskellBackend;
      const bytes = await fetcher(source.repo, source.path, release);
      if (bytes === undefined) {
        return {
          repo: source.repo,
          path: source.path,
          tier: source.tier,
          status: "missing",
          expected: source.sha256,
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
      };
    }),
  );

  return {
    releases,
    recordedAt,
    verdicts: { format: verdictOf(files, "format"), content: verdictOf(files, "content") },
    files,
  };
}
