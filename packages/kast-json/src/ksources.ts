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
 * offline; `cli.ts` supplies the one that talks to GitHub.
 */

import { SORT_SPELLING_SOURCE, TRANSCRIBED_FROM, type KastRevision } from "./version.js";

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
 * Web Crypto, reached through `globalThis` rather than named directly.
 *
 * The emit config sets `types: []` so the published `.d.ts` cannot make
 * consumers depend on `@types/bun`, which also means no ambient `crypto`.
 * Declaring one here would collide with Bun's under the development config, so
 * the global is narrowed by a cast instead: it type-checks under both, and
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
 * Compare a declared set of files against their counterparts at `release`.
 *
 * This is the single-baseline core; `checkKRevisions` is the multi-revision
 * question this package actually asks of itself.  Kept exported because "do
 * these files, hashed at that release, still hold at this one?" is a question
 * a consumer may want to ask about its own manifest.
 *
 * Throws whatever `fetcher` throws: a network failure is not a verdict, and
 * reporting one as `missing` would turn "I could not ask" into "K moved it".
 */
export async function checkKSources(
  release: string,
  fetcher: KSourceFetcher,
  sources: readonly KSourceFile[],
  recordedAt: string,
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

///////////////////////////////
// Multi-revision checking   //
///////////////////////////////

/** What one declared path turned out to hold at the requested release. */
export interface KObservedFile {
  readonly path: string;
  /** sha256 observed at the release; absent when the path does not exist. */
  readonly actual?: string;
}

/**
 * The multi-revision answer.  `matched` names the one revision whose every
 * file — `ToJson.java`, `JsonParser.java`, *and* the shared `ADT.scala` sort
 * spelling — is byte-identical at the requested release, which is the only
 * situation in which this package's transcription is known to hold there.
 *
 * - `matched` — that release speaks a KAST version this package transcribes.
 * - `changed` — every path exists but no recorded revision matches.  A human
 *   must diff before trusting this package at that release.
 * - `could-not-locate` — a declared path is gone (K refactored).  *Not* a
 *   compatibility verdict; the check has stopped being able to answer.  As in
 *   `KSourcesVerdict`, definite drift outranks a missing path: if any present
 *   file matches no recorded hash, the verdict is `changed` even when another
 *   path is missing.
 */
export interface KRevisionsReport {
  /** The K release tag the question was asked about. */
  readonly release: string;
  readonly verdict: "matched" | "changed" | "could-not-locate";
  /** The matching revision, when `verdict` is `"matched"`. */
  readonly matched?: KastRevision;
  /** Every recorded revision, in manifest order, with its match outcome. */
  readonly revisions: readonly { readonly revision: KastRevision; readonly matches: boolean }[];
  /** What was actually observed at `release`, one entry per declared path. */
  readonly files: readonly KObservedFile[];
}

/**
 * "Which of this package's transcriptions does K `release` speak?"
 *
 * Fetches each *distinct* declared path once, hashes it, and compares against
 * every revision in `revisions` plus the shared `sortSpelling` source — by
 * default this package's own `TRANSCRIBED_FROM` and `SORT_SPELLING_SOURCE`.
 * At most one revision can match, since the revisions differ pairwise in at
 * least one recorded hash.  The manifest parameters exist so the verdict
 * logic is testable offline; real callers never pass them.
 *
 * Throws whatever `fetcher` throws, for the same reason as `checkKSources`.
 */
export async function checkKRevisions(
  release: string,
  fetcher: KSourceFetcher,
  revisions: readonly KastRevision[] = TRANSCRIBED_FROM,
  sortSpelling: KSourceFile = SORT_SPELLING_SOURCE,
): Promise<KRevisionsReport> {
  const paths = [...new Set([...revisions.flatMap((r) => [r.toJson.path, r.jsonParser.path]), sortSpelling.path])];

  const observed = new Map<string, string | undefined>();
  await Promise.all(
    paths.map(async (path) => {
      const bytes = await fetcher(path, release);
      observed.set(path, bytes === undefined ? undefined : await sha256Hex(bytes));
    }),
  );

  const files: KObservedFile[] = paths.map((path) => {
    const actual = observed.get(path);
    return actual === undefined ? { path } : { path, actual };
  });

  const outcomes = revisions.map((revision) => ({
    revision,
    matches:
      observed.get(revision.toJson.path) === revision.toJson.sha256 &&
      observed.get(revision.jsonParser.path) === revision.jsonParser.sha256 &&
      observed.get(sortSpelling.path) === sortSpelling.sha256,
  }));

  const matched = outcomes.find((r) => r.matches)?.revision;
  const recordedFor = (path: string): readonly string[] =>
    [...revisions.flatMap((r) => [r.toJson, r.jsonParser]), sortSpelling]
      .filter((f) => f.path === path)
      .map((f) => f.sha256);
  const definiteDrift = paths.some((path) => {
    const actual = observed.get(path);
    return actual !== undefined && !recordedFor(path).includes(actual);
  });
  const anyMissing = paths.some((path) => observed.get(path) === undefined);

  const verdict: KRevisionsReport["verdict"] =
    matched === undefined ? (definiteDrift || !anyMissing ? "changed" : "could-not-locate") : "matched";

  return matched === undefined
    ? { release, verdict, revisions: outcomes, files }
    : { release, verdict, matched, revisions: outcomes, files };
}
