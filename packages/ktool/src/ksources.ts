/**
 * Answering "does this transcription still hold at K release vX?" — the same
 * question `kast`, `kast-json`, `kore`, `konvert`, `k-parser` and `kompiled`
 * answer, asked about the files in `version.ts`'s manifest.
 *
 * The logic is pure and takes its fetcher as an argument, so it runs offline in
 * tests; `src/cli.ts` supplies one that talks to GitHub, behind
 * `ktool check-k <release>`.
 *
 * # What is different here
 *
 * One repository, two tiers — the same shape as `konvert`'s and `kompiled`'s.
 * What the `content` tier *means* is the difference: elsewhere it is "the Java
 * original this was re-implemented from", advisory because the format is
 * unaffected. Here it is `KompileOptions.java`, the declaration of which flags
 * `kompile` accepts, and a rename there makes every argv this package builds
 * for that flag wrong. Still advisory — an *added* flag breaks nothing, and
 * only a human can tell the cases apart — but read it, do not skim it.
 */

import {
  K_RELEASE,
  TRANSCRIBED_FROM,
  type KtoolSourceRepo,
  type KtoolSourceTier,
  type KtoolTranscribedSource,
} from "./version.js";

/** What a single declared file turned out to be at the requested release. */
export type KtoolSourceStatus = "unchanged" | "changed" | "missing";

export interface KtoolSourceOutcome {
  readonly repo: KtoolSourceRepo;
  readonly path: string;
  readonly tier: KtoolSourceTier;
  readonly status: KtoolSourceStatus;
  /** The sha256 recorded in this package. */
  readonly expected: string;
  /** The sha256 observed at the requested release; absent when `missing`. */
  readonly actual?: string;
  /** Why the file is in the manifest — carried through so a report is readable. */
  readonly why: string;
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
export type KtoolSourcesVerdict = "unchanged" | "changed" | "could-not-locate";

export interface KtoolSourcesReport {
  /** The K release the question was asked about. */
  readonly release: string;
  /** The K release the recorded hashes were taken at. */
  readonly recordedAt: string;
  /**
   * Per-tier verdicts. `format` is the one that gates trust in the
   * transcription; `content` drifting means the flags themselves may have
   * moved, which this package can only warn about.
   */
  readonly verdicts: Readonly<Record<KtoolSourceTier, KtoolSourcesVerdict>>;
  readonly files: readonly KtoolSourceOutcome[];
}

/**
 * Fetches one file from one repository at one release. Returns `undefined`
 * when the path does not exist at that tag — which must be distinguished from a
 * network failure, so an implementation should throw for anything that is not a
 * clean 404.
 */
export type KtoolSourceFetcher = (
  repo: KtoolSourceRepo,
  path: string,
  release: string,
) => Promise<Uint8Array | undefined>;

/**
 * Web Crypto, reached through `globalThis` rather than named directly — the
 * same mechanism, and the same reason, as `packages/kompiled/src/ksources.ts`:
 * no Node-only import, so this module stays runnable anywhere.
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

function verdictOf(files: readonly KtoolSourceOutcome[], tier: KtoolSourceTier): KtoolSourcesVerdict {
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
export async function checkKtoolSources(
  release: string,
  fetcher: KtoolSourceFetcher,
  sources: readonly KtoolTranscribedSource[] = TRANSCRIBED_FROM,
  recordedAt: string = K_RELEASE,
): Promise<KtoolSourcesReport> {
  const files: KtoolSourceOutcome[] = await Promise.all(
    sources.map(async (source): Promise<KtoolSourceOutcome> => {
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
    verdicts: { format: verdictOf(files, "format"), content: verdictOf(files, "content") },
    files,
  };
}
