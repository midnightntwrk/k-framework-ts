/**
 * Answering "does this transcription still hold at K release vX?" — the same
 * question `packages/kast-json`, `packages/kast` and `packages/kore` answer,
 * asked about a different set of files.
 *
 * The logic is pure and takes its fetcher as an argument, so it runs offline in
 * tests; `cli.ts` supplies one that talks to GitHub.
 *
 * # What is different here
 *
 * One repository — `runtimeverification/k` — because `LLVMBackend.java` lives
 * in the k repo's own `llvm-backend/` directory rather than in the submodule.
 * So no per-repo release resolution, unlike `packages/kore`.
 *
 * And the **content tier means something stronger** than it does elsewhere.  In
 * `kore` it is `ModuleToKORE.java`, whose churn is advisory because the KORE
 * *grammar* is unaffected.  Here it is the set of Java files that decide what
 * lands on disk, plus the `README.md` `kompile` copies into every kompiled
 * directory — the only prose description of the layout that exists.  A diff in
 * that README is the closest thing to a spec change this format can have, and
 * it is still advisory, because the layout has no version number and K says so
 * itself: *"the content and the format of these files are subject to change
 * without warning"*.  A mismatch is a warning, not an exit code.
 */

import {
  K_RELEASE,
  TRANSCRIBED_FROM,
  type KompiledSourceRepo,
  type KompiledSourceTier,
  type KompiledTranscribedSource,
} from "./version.js";

/** What a single declared file turned out to be at the requested release. */
export type KompiledSourceStatus = "unchanged" | "changed" | "missing";

export interface KompiledSourceOutcome {
  readonly repo: KompiledSourceRepo;
  readonly path: string;
  readonly tier: KompiledSourceTier;
  readonly status: KompiledSourceStatus;
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
export type KompiledSourcesVerdict = "unchanged" | "changed" | "could-not-locate";

export interface KompiledSourcesReport {
  /** The K release the question was asked about. */
  readonly release: string;
  /** The K release the recorded hashes were taken at. */
  readonly recordedAt: string;
  /**
   * Per-tier verdicts.  `format` is the one that gates trust in the
   * transcription; `content` drifting means the *directory layout* may have
   * moved, which this package can only warn about.
   */
  readonly verdicts: Readonly<Record<KompiledSourceTier, KompiledSourcesVerdict>>;
  readonly files: readonly KompiledSourceOutcome[];
}

/**
 * Fetches one file from one repository at one release.  Returns `undefined`
 * when the path does not exist at that tag — which must be distinguished from a
 * network failure, so an implementation should throw for anything that is not a
 * clean 404.
 */
export type KompiledSourceFetcher = (
  repo: KompiledSourceRepo,
  path: string,
  release: string,
) => Promise<Uint8Array | undefined>;

/**
 * Web Crypto, reached through `globalThis` rather than named directly — the
 * same mechanism, and the same reason, as `packages/kore/src/ksources.ts`.
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

function verdictOf(files: readonly KompiledSourceOutcome[], tier: KompiledSourceTier): KompiledSourcesVerdict {
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
export async function checkKompiledSources(
  release: string,
  fetcher: KompiledSourceFetcher,
  sources: readonly KompiledTranscribedSource[] = TRANSCRIBED_FROM,
  recordedAt: string = K_RELEASE,
): Promise<KompiledSourcesReport> {
  const files: KompiledSourceOutcome[] = await Promise.all(
    sources.map(async (source): Promise<KompiledSourceOutcome> => {
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
