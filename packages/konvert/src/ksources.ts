/**
 * Answering "does this transcription still hold at K release vX?" — for any
 * `vX`, including releases published after this package was.
 *
 * Same design as `@kframework-ts/kast`'s and `@kframework-ts/kore`'s
 * `ksources.ts` (see those files and `docs/versioning.md` for the argument),
 * with the shape this package's manifest needs: **one repository, two tiers**.
 * `kore`'s version carries both twists; `kast`'s carries neither. This is the
 * fourth copy of the machinery, which is the point at which a shared internal
 * helper stops being premature — it is written out again here rather than
 * extracted mid-package, so that the extraction is one change and not two.
 *
 * The exit-code contract the CLI applies is the tiers' contract too: only the
 * `format` verdict gates trust in this package. `content` drift means the
 * Java/Scala originals moved, which is worth reading and is not, by itself, a
 * finding about the translation.
 *
 * The logic is pure and takes its fetcher as an argument, so it is tested
 * offline; `cli.ts` supplies one that talks to GitHub.
 */

import { K_RELEASE, type KonvertSourceTier, type KonvertTranscribedSource, TRANSCRIBED_FROM } from "./version.js";

/** What a single declared file turned out to be at the requested release. */
export type KonvertSourceStatus = "unchanged" | "changed" | "missing";

export interface KonvertSourceOutcome {
  /** Path within the `runtimeverification/k` tree. */
  readonly path: string;
  readonly tier: KonvertSourceTier;
  readonly status: KonvertSourceStatus;
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
export type KonvertSourcesVerdict = "unchanged" | "changed" | "could-not-locate";

export interface KonvertSourcesReport {
  /** The K release tag the question was asked about. */
  readonly release: string;
  /** The release the recorded hashes were taken at. */
  readonly recordedAt: string;
  /**
   * Per-tier verdicts. `format` is the one that gates trust in this package;
   * `content` drifting only means the references pyk re-implements have moved.
   */
  readonly verdicts: Readonly<Record<KonvertSourceTier, KonvertSourcesVerdict>>;
  readonly files: readonly KonvertSourceOutcome[];
}

/**
 * Fetches one file from a K release. Returns `undefined` when the path does not
 * exist at that tag — which must be distinguished from a network failure, so an
 * implementation should throw for anything that is not a clean 404.
 */
export type KonvertSourceFetcher = (path: string, release: string) => Promise<Uint8Array | undefined>;

/**
 * Web Crypto, reached through `globalThis` rather than named directly.
 *
 * The emit config sets `types: []` so the published `.d.ts` cannot make
 * consumers depend on `@types/bun`, which also means no ambient `crypto`.
 * Declaring one here would collide with Bun's under the development config, so
 * the global is narrowed by a cast instead.
 */
interface SubtleLike {
  digest(algorithm: string, data: ArrayBuffer): Promise<ArrayBuffer>;
}

/** Lowercase hex sha256 of `bytes`, via Web Crypto — no Node-only imports. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // The assertion is the mechanism described above, not an oversight: it is how
  // a global is reached without an ambient declaration that would collide with
  // Bun's. It narrows to the single method used, so it cannot mask a real type.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const { crypto } = globalThis as unknown as { crypto: { subtle: SubtleLike } };
  // A Uint8Array may be a view onto a larger buffer, so hash the exact window
  // rather than everything the buffer happens to hold.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const view = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", view);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function verdictOf(files: readonly KonvertSourceOutcome[], tier: KonvertSourceTier): KonvertSourcesVerdict {
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
 * reporting one as `missing` would turn "I could not ask" into "K moved it".
 */
export async function checkKonvertSources(
  release: string,
  fetcher: KonvertSourceFetcher,
  sources: readonly KonvertTranscribedSource[] = TRANSCRIBED_FROM,
  recordedAt: string = K_RELEASE,
): Promise<KonvertSourcesReport> {
  // Concurrent: these are independent network reads, and the declared order is
  // restored by `Promise.all` regardless of which returns first.
  const files: KonvertSourceOutcome[] = await Promise.all(
    sources.map(async (source): Promise<KonvertSourceOutcome> => {
      const bytes = await fetcher(source.path, release);
      if (bytes === undefined) {
        return { path: source.path, tier: source.tier, status: "missing", expected: source.sha256 };
      }
      const actual = await sha256Hex(bytes);
      return {
        path: source.path,
        tier: source.tier,
        status: actual === source.sha256 ? "unchanged" : "changed",
        expected: source.sha256,
        actual,
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
