/**
 * Answering "does this transcription still hold at K release vX?" — the house
 * drift check, over this package's three declared files.
 *
 * The logic is pure and takes its fetcher as an argument, so it runs offline in
 * tests; `cli.ts` supplies one that talks to GitHub.
 *
 * Both tiers gate the exit code, for the reason `packages/kcovr` gives about
 * *its* reference tier: `test_fuzz.py` is not a test of a specification that
 * exists elsewhere, it **is** the specification — `kfuzz.py` has no unit test,
 * no doctest and no documented contract beyond its docstrings, so the
 * integration test is the only place upstream says what the module is supposed
 * to do.  A change to it invalidates this package's answers as surely as a
 * change to `kfuzz.py` itself.
 */

import { K_RELEASE, TRANSCRIBED_FROM, type KfuzzTranscribedSource } from "./version.js";

/** What one declared file turned out to be at the requested release. */
export type KfuzzSourceStatus = "unchanged" | "changed" | "missing";

export interface KfuzzSourceOutcome {
  readonly path: string;
  readonly status: KfuzzSourceStatus;
  /** The sha256 recorded in this package. */
  readonly expected: string;
  /** The sha256 observed at the requested release; absent when `missing`. */
  readonly actual?: string;
  readonly tier: KfuzzTranscribedSource["tier"];
  /** Why the file is in the manifest — carried through so a report is readable. */
  readonly why: string;
}

/**
 * A three-valued answer, never a boolean:
 *
 * - `unchanged` — every declared file is byte-identical.
 * - `changed` — at least one differs.  A human must diff it.
 * - `could-not-locate` — nothing differed, but a path is gone; the check has
 *   stopped being able to answer, which is not a verdict about compatibility.
 *
 * `changed` outranks `could-not-locate`: a demonstrable diff is a definite
 * finding, a missing path only an inconclusive one.
 */
export type KfuzzSourcesVerdict = "unchanged" | "changed" | "could-not-locate";

export interface KfuzzSourcesReport {
  /** The K release the question was asked about. */
  readonly release: string;
  /** The K release the recorded hashes were taken at. */
  readonly recordedAt: string;
  readonly verdict: KfuzzSourcesVerdict;
  readonly files: readonly KfuzzSourceOutcome[];
}

/**
 * Fetches one path from `runtimeverification/k` at one release.  `undefined`
 * means an unambiguous 404; anything else — a network failure, a 500 — must
 * throw, because "I could not ask" is not "upstream moved it".
 */
export type KfuzzSourceFetcher = (path: string, release: string) => Promise<Uint8Array | undefined>;

/**
 * Web Crypto, reached through `globalThis` rather than named directly — the
 * same mechanism, and the same reason, as `packages/proof/src/ksources.ts`.
 */
interface SubtleLike {
  digest(algorithm: string, data: ArrayBuffer): Promise<ArrayBuffer>;
}

/** Lowercase hex sha256 of exactly `bytes`, via Web Crypto — no Node-only imports. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const { crypto } = globalThis as unknown as { crypto: { subtle: SubtleLike } };
  // A Uint8Array can be a window into a larger buffer; hash only that window.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const view = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", view);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Compare every declared file against its counterpart at `release`.
 *
 * Throws whatever `fetcher` throws: a network failure is not a verdict, and
 * reporting one as `missing` would turn "I could not ask" into "upstream moved
 * it".
 */
export async function checkKfuzzSources(
  release: string,
  fetcher: KfuzzSourceFetcher,
  sources: readonly KfuzzTranscribedSource[] = TRANSCRIBED_FROM,
  recordedAt: string = K_RELEASE,
): Promise<KfuzzSourcesReport> {
  const files = await Promise.all(
    sources.map(async (source): Promise<KfuzzSourceOutcome> => {
      const bytes = await fetcher(source.path, release);
      if (bytes === undefined) {
        return { path: source.path, status: "missing", expected: source.sha256, tier: source.tier, why: source.why };
      }
      const actual = await sha256Hex(bytes);
      return {
        path: source.path,
        status: actual === source.sha256 ? "unchanged" : "changed",
        expected: source.sha256,
        actual,
        tier: source.tier,
        why: source.why,
      };
    }),
  );
  const verdict: KfuzzSourcesVerdict = files.some((file) => file.status === "changed")
    ? "changed"
    : files.some((file) => file.status === "missing")
      ? "could-not-locate"
      : "unchanged";
  return { release, recordedAt, verdict, files };
}
