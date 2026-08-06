/**
 * Answering "does this transcription still hold at K release vX?" — for any
 * `vX`, including releases published after this package was.
 *
 * The package records what it was transcribed from (`TRANSCRIBED_FROM`: paths
 * plus sha256 at `K_RELEASE`).  Given that, the question is decided by fetching
 * the same paths at the requested tag and comparing hashes, rather than by
 * consulting a list of releases somebody had to enumerate in advance.  See
 * `docs/versioning.md` for why a declared "verified through vX" range was
 * rejected in favour of this.
 *
 * The logic here is pure and takes its fetcher as an argument, so it is tested
 * offline; `cli.ts` supplies the one that talks to GitHub.  It is a sibling of
 * `kast`'s and `kast-json`'s `ksources.ts` on purpose — the packages share no
 * code, so each carries its own copy of this small machinery.
 */

import { K_RELEASE, TRANSCRIBED_FROM } from "./version.js";

/** A file this package is derived from, and its sha256 at a known K release. */
export interface KSourceFile {
  /** Path within the `runtimeverification/k` tree. */
  readonly path: string;
  /** Lowercase hex sha256 of that file at the release it was recorded at. */
  readonly sha256: string;
}

/**
 * What a single declared file turned out to be at the requested release.
 *
 * `missing` is a distinct outcome from `changed` on purpose: a path that does
 * not exist means K moved things, which is not a verdict about compatibility.
 */
export type KSourceStatus = "unchanged" | "changed" | "missing";

export interface KSourceOutcome {
  readonly path: string;
  readonly status: KSourceStatus;
  /** The sha256 recorded in this package. */
  readonly expected: string;
  /** The sha256 observed at the requested release; absent when `missing`. */
  readonly actual?: string;
}

/**
 * The overall answer.  Three-valued, never boolean — see `docs/versioning.md`.
 *
 * - `unchanged` — every declared file is byte-identical. The transcription holds.
 * - `changed` — at least one declared file differs. A human must diff it.
 * - `could-not-locate` — nothing differed, but at least one path is gone. This
 *   is *not* a compatibility verdict; the check has stopped being able to
 *   answer, and the manifest has to be re-established by hand.
 *
 * `changed` outranks `could-not-locate`, because a file that demonstrably
 * differs is a definite finding, while a missing path is only an inconclusive
 * one.  Either way the answer is "a human must look".
 */
export type KSourcesVerdict = "unchanged" | "changed" | "could-not-locate";

export interface KSourcesReport {
  /** The K release tag the question was asked about. */
  readonly release: string;
  /** The release the recorded hashes were taken at. */
  readonly recordedAt: string;
  readonly verdict: KSourcesVerdict;
  readonly files: readonly KSourceOutcome[];
}

/**
 * Fetches one file from a K release.  Returns `undefined` when the path does
 * not exist at that tag — which must be distinguished from a network failure,
 * so an implementation should throw for anything that is not a clean 404.
 */
export type KSourceFetcher = (path: string, release: string) => Promise<Uint8Array | undefined>;

/**
 * The files this package is a transcription of, derived from the manifest so
 * the two can never disagree about what is declared.
 */
export const KAST_SOURCES: readonly KSourceFile[] = TRANSCRIBED_FROM.map(({ path, sha256 }) => ({
  path,
  sha256,
}));

/**
 * Web Crypto, reached through `globalThis` rather than named directly.
 *
 * The emit config's ambient types don't include a DOM `crypto`, and declaring
 * one here would collide with Bun's under the development config, so the
 * global is narrowed by a cast instead: it type-checks under both, and
 * describes exactly the one method used.
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

/**
 * Compare every declared file against its counterpart at `release`.
 *
 * Throws whatever `fetcher` throws: a network failure is not a verdict, and
 * reporting one as `missing` would turn "I could not ask" into "K moved it".
 */
export async function checkKSources(
  release: string,
  fetcher: KSourceFetcher,
  sources: readonly KSourceFile[] = KAST_SOURCES,
  recordedAt: string = K_RELEASE,
): Promise<KSourcesReport> {
  // Concurrent: these are independent network reads, and the declared order is
  // restored by `Promise.all` regardless of which returns first.
  const files: KSourceOutcome[] = await Promise.all(
    sources.map(async (source): Promise<KSourceOutcome> => {
      const bytes = await fetcher(source.path, release);
      if (bytes === undefined) {
        return { path: source.path, status: "missing", expected: source.sha256 };
      }
      const actual = await sha256Hex(bytes);
      return {
        path: source.path,
        status: actual === source.sha256 ? "unchanged" : "changed",
        expected: source.sha256,
        actual,
      };
    }),
  );

  const verdict: KSourcesVerdict = files.some((f) => f.status === "changed")
    ? "changed"
    : files.some((f) => f.status === "missing")
      ? "could-not-locate"
      : "unchanged";

  return { release, recordedAt, verdict, files };
}
