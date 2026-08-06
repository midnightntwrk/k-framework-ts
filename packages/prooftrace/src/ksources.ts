/**
 * Answering "does this reader still hold at K release vX?" — the house drift
 * check, over this package's fourteen declared files.
 *
 * Same design as `@kframework-ts/kore-rpc`'s `ksources.ts`, which is the
 * variant this package needs: **two repositories, per-tier verdicts**.  The
 * sources span `runtimeverification/k` and
 * `runtimeverification/llvm-backend`, so the caller supplies a release per repo
 * and the fetcher receives the repo alongside the path.  `version.ts` argues
 * the tiers; `docs/versioning.md` argues the mechanism.
 *
 * The logic is pure and takes its fetcher as an argument, so it runs offline in
 * tests; `cli.ts` supplies one that talks to GitHub, and resolves the
 * llvm-backend release from the K tag's submodule pin when it is not given.
 */

import {
  K_RELEASE,
  LLVM_BACKEND_RELEASE,
  TRANSCRIBED_FROM,
  type ProofTraceSourceRepo,
  type ProofTraceSourceTier,
  type ProofTraceTranscribedSource,
} from "./version.js";

/** What one declared file turned out to be at the requested release. */
export type ProofTraceSourceStatus = "unchanged" | "changed" | "missing";

export interface ProofTraceSourceOutcome {
  readonly repo: ProofTraceSourceRepo;
  readonly path: string;
  readonly tier: ProofTraceSourceTier;
  readonly status: ProofTraceSourceStatus;
  /** The sha256 recorded in this package. */
  readonly expected: string;
  /** The sha256 observed at the requested release; absent when `missing`. */
  readonly actual?: string;
  /** Why the file is in the manifest — carried through so a report is readable. */
  readonly why: string;
}

/**
 * A per-tier answer, three-valued and never boolean:
 *
 * - `unchanged` — every declared file in the tier is byte-identical;
 * - `changed` — at least one differs, and a human must diff it;
 * - `could-not-locate` — nothing differed but a path is gone, so the check has
 *   stopped being able to answer, which is not a verdict about compatibility.
 *
 * `changed` outranks `could-not-locate`: a demonstrable diff is a definite
 * finding, a missing path only an inconclusive one.
 */
export type ProofTraceSourcesVerdict = "unchanged" | "changed" | "could-not-locate";

/** The releases a question is asked about — one per repository. */
export interface ProofTraceReleases {
  /** Tag in `runtimeverification/k`, e.g. `"v7.1.337"`. */
  readonly k: string;
  /** Tag (or bare commit) in `runtimeverification/llvm-backend`, e.g. `"v0.1.140"`. */
  readonly llvmBackend: string;
}

export interface ProofTraceSourcesReport {
  readonly releases: ProofTraceReleases;
  /** The releases the recorded hashes were taken at. */
  readonly recordedAt: ProofTraceReleases;
  /**
   * Per-tier verdicts.  `format` gates trust in the reader; `ordinal` gates
   * trust in the *attribution*, which is a different claim; `api` is advisory.
   */
  readonly verdicts: Readonly<Record<ProofTraceSourceTier, ProofTraceSourcesVerdict>>;
  readonly files: readonly ProofTraceSourceOutcome[];
}

/**
 * Fetches one file from one repository at one release.  `undefined` means an
 * unambiguous 404; anything else — a network failure, a 500 — must throw,
 * because "I could not ask" is not "upstream moved it".
 */
export type ProofTraceSourceFetcher = (
  repo: ProofTraceSourceRepo,
  path: string,
  release: string,
) => Promise<Uint8Array | undefined>;

/**
 * Web Crypto, reached through `globalThis` rather than named directly — the
 * same mechanism, and the same reason, as every sibling's `ksources.ts`: the
 * emit config sets `types: ["node"]`, and declaring `crypto` here would collide
 * with Bun's under the development config.
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

function verdictOf(files: readonly ProofTraceSourceOutcome[], tier: ProofTraceSourceTier): ProofTraceSourcesVerdict {
  const inTier = files.filter((file) => file.tier === tier);
  return inTier.some((file) => file.status === "changed")
    ? "changed"
    : inTier.some((file) => file.status === "missing")
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
export async function checkProofTraceSources(
  releases: ProofTraceReleases,
  fetcher: ProofTraceSourceFetcher,
  sources: readonly ProofTraceTranscribedSource[] = TRANSCRIBED_FROM,
  recordedAt: ProofTraceReleases = { k: K_RELEASE, llvmBackend: LLVM_BACKEND_RELEASE },
): Promise<ProofTraceSourcesReport> {
  const files = await Promise.all(
    sources.map(async (source): Promise<ProofTraceSourceOutcome> => {
      const release = source.repo === "runtimeverification/k" ? releases.k : releases.llvmBackend;
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
    releases,
    recordedAt,
    verdicts: {
      format: verdictOf(files, "format"),
      ordinal: verdictOf(files, "ordinal"),
      api: verdictOf(files, "api"),
    },
    files,
  };
}
