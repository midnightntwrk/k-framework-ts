/**
 * Answering "does this transcription still hold at K release vX?" — for any
 * `vX`, including releases published after this package was.
 *
 * Same design as `@kframework-ts/kore`'s `ksources.ts`, which is the variant
 * this package needs verbatim: **two repositories, two tiers**. The sources
 * span `runtimeverification/k` and `runtimeverification/haskell-backend`, so
 * the caller supplies a release *per repo* and the fetcher receives the repo
 * alongside the path; and `format` (what the wire *is*) gets a separate verdict
 * from `content` (what the reference client and the two servers *do*), because
 * only the first gates trust in the transcription. See `version.ts` for the
 * tier rationale, and `docs/versioning.md` for the argument behind the whole
 * mechanism.
 *
 * This is knowingly the **fifth** copy of this machinery (`kast`, `kast-json`,
 * `kore`, `konvert`, and now this one) — konvert's header already noted that
 * the fourth was past the point where a shared internal helper stops being
 * premature. It is written out again anyway: extracting it means editing five
 * packages at once, and this package's landing was deliberately not made to
 * depend on that cross-package refactor. The extraction, when it happens, is
 * one change touching five identical files instead of two touching four.
 *
 * The logic is pure and takes its fetcher as an argument, so it is tested
 * offline; `cli.ts` supplies one that talks to GitHub.
 */

import {
  HASKELL_BACKEND_RELEASE,
  K_RELEASE,
  type KoreRpcSourceRepo,
  type KoreRpcSourceTier,
  type KoreRpcTranscribedSource,
  TRANSCRIBED_FROM,
} from "./version.js";

/** What a single declared file turned out to be at the requested release. */
export type KoreRpcSourceStatus = "unchanged" | "changed" | "missing";

export interface KoreRpcSourceOutcome {
  readonly repo: KoreRpcSourceRepo;
  readonly path: string;
  readonly tier: KoreRpcSourceTier;
  readonly status: KoreRpcSourceStatus;
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
 * - `could-not-locate` — nothing differed, but at least one path is gone; the
 *   check has stopped being able to answer, which is not a verdict.
 *
 * `changed` outranks `could-not-locate`: a demonstrable diff is a definite
 * finding, a missing path only an inconclusive one.
 */
export type KoreRpcSourcesVerdict = "unchanged" | "changed" | "could-not-locate";

/** The releases a question is asked about — one per repository. */
export interface KoreRpcReleases {
  /** Tag in `runtimeverification/k`, e.g. `"v7.1.337"`. */
  readonly k: string;
  /** Tag (or bare commit) in `runtimeverification/haskell-backend`, e.g. `"v0.1.155"`. */
  readonly haskellBackend: string;
}

export interface KoreRpcSourcesReport {
  /** The releases the question was asked about. */
  readonly releases: KoreRpcReleases;
  /** The releases the recorded hashes were taken at. */
  readonly recordedAt: KoreRpcReleases;
  /**
   * Per-tier verdicts. `format` is the one that gates trust in this package:
   * it is the six `Kore/JsonRpc/*.hs` files, i.e. the wire itself. `content`
   * drifting means pyk, the two servers' behaviour, or the prose spec moved —
   * worth reading, not by itself a translation finding.
   */
  readonly verdicts: Readonly<Record<KoreRpcSourceTier, KoreRpcSourcesVerdict>>;
  readonly files: readonly KoreRpcSourceOutcome[];
}

/**
 * Fetches one file from one repository at one release. Returns `undefined`
 * when the path does not exist at that tag — which must be distinguished from
 * a network failure, so an implementation should throw for anything that is
 * not a clean 404.
 */
export type KoreRpcSourceFetcher = (
  repo: KoreRpcSourceRepo,
  path: string,
  release: string,
) => Promise<Uint8Array | undefined>;

/**
 * Web Crypto, reached through `globalThis` rather than named directly.
 *
 * The emit config sets `types: ["node"]` so the published `.d.ts` cannot make
 * consumers depend on `@types/bun`; declaring a `crypto` here would collide
 * with Bun's under the development config. The global is narrowed by a cast
 * instead: it type-checks under both, and describes exactly the one method
 * used.
 */
interface SubtleLike {
  digest(algorithm: string, data: ArrayBuffer): Promise<ArrayBuffer>;
}

/** Lowercase hex sha256 of `bytes`, via Web Crypto — no Node-only imports. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // The assertion is the mechanism described above, not an oversight: it is
  // how a global is reached without an ambient declaration that would collide
  // with Bun's. It narrows to the single method used, so it cannot mask a real
  // type.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const { crypto } = globalThis as unknown as { crypto: { subtle: SubtleLike } };
  // A Uint8Array may be a view onto a larger buffer, so hash the exact window
  // rather than everything the buffer happens to hold.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const view = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", view);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function verdictOf(files: readonly KoreRpcSourceOutcome[], tier: KoreRpcSourceTier): KoreRpcSourcesVerdict {
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
 * reporting one as `missing` would turn "I could not ask" into "upstream moved
 * it".
 */
export async function checkKoreRpcSources(
  releases: KoreRpcReleases,
  fetcher: KoreRpcSourceFetcher,
  sources: readonly KoreRpcTranscribedSource[] = TRANSCRIBED_FROM,
  recordedAt: KoreRpcReleases = { k: K_RELEASE, haskellBackend: HASKELL_BACKEND_RELEASE },
): Promise<KoreRpcSourcesReport> {
  // Concurrent: these are independent network reads, and the declared order is
  // restored by `Promise.all` regardless of which returns first.
  const files: KoreRpcSourceOutcome[] = await Promise.all(
    sources.map(async (source): Promise<KoreRpcSourceOutcome> => {
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
