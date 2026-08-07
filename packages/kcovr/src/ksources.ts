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
 * # Submodule and delegated authorities
 *
 * `io.cpp` — see `version.ts`'s `IO_CPP_IDENTITY`.  It lives in the
 * `llvm-backend` submodule, so the checker resolves the gitlink K records at
 * the requested tag before fetching it from llvm-backend at that exact commit.
 * `allRules.txt`'s producer, `Kompile.java`, is deliberately absent: it is pinned by
 * `@kframework-ts/kompiled`'s manifest instead of duplicated here: this package
 * does not parse that file, it delegates.
 */

import {
  IO_CPP_IDENTITY,
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
  /** The repository revision from which `path` was actually fetched. */
  readonly revision: string;
  readonly tier: KcovrSourceTier;
  readonly status: KcovrSourceStatus;
  /** The sha256 recorded in this package. */
  readonly expected: string;
  /** The sha256 observed at the requested release; absent when `missing`. */
  readonly actual?: string;
  /** Why the file is in the manifest — carried through so a report is readable. */
  readonly why: string;
  /** Present for `io.cpp`: K repo/release and exact gitlink used to resolve it. */
  readonly resolvedFrom?: {
    readonly repo: "runtimeverification/k";
    readonly release: string;
    readonly path: "llvm-backend/src/main/native/llvm-backend";
    readonly commit?: string;
  };
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
 * The two read-only operations a source checker needs.  `gitlink` reads a
 * submodule entry from a repository tree, rather than looking for a matching
 * tag in the submodule repository.  `undefined` is a clean 404/missing entry;
 * a transport failure must throw so it is never reported as source drift.
 */
export interface KcovrSourceFetcher {
  file(repo: KcovrSourceRepo, path: string, revision: string): Promise<Uint8Array | undefined>;
  gitlink(
    repo: "runtimeverification/k",
    path: "llvm-backend/src/main/native/llvm-backend",
    revision: string,
  ): Promise<string | undefined>;
}

/** A malformed submodule gitlink cannot safely be treated as a missing file. */
export class InvalidKcovrGitlinkError extends Error {
  readonly repo = "runtimeverification/k" as const;
  readonly path = "llvm-backend/src/main/native/llvm-backend" as const;
  readonly release: string;
  readonly gitlink: string;

  constructor(release: string, gitlink: string) {
    super(`Invalid llvm-backend gitlink at runtimeverification/k@${release}: ${gitlink}`);
    this.name = "InvalidKcovrGitlinkError";
    this.release = release;
    this.gitlink = gitlink;
  }
}

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
      const bytes = await fetcher.file(source.repo, source.path, release);
      if (bytes === undefined) {
        return {
          repo: source.repo,
          path: source.path,
          revision: release,
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
        revision: release,
        tier: source.tier,
        status: actual === source.sha256 ? "unchanged" : "changed",
        expected: source.sha256,
        actual,
        why: source.why,
      };
    }),
  );

  const gitlink = await fetcher.gitlink("runtimeverification/k", IO_CPP_IDENTITY.gitlinkPath, release);
  if (gitlink === undefined) {
    files.push({
      repo: IO_CPP_IDENTITY.repo,
      path: IO_CPP_IDENTITY.path,
      revision: "",
      tier: "reference",
      status: "missing",
      expected: IO_CPP_IDENTITY.sha256,
      why: IO_CPP_IDENTITY.why,
      resolvedFrom: { repo: "runtimeverification/k", release, path: IO_CPP_IDENTITY.gitlinkPath },
    });
  } else {
    if (!/^[0-9a-f]{40}$/u.test(gitlink)) throw new InvalidKcovrGitlinkError(release, gitlink);
    const bytes = await fetcher.file(IO_CPP_IDENTITY.repo, IO_CPP_IDENTITY.path, gitlink);
    const resolvedFrom = {
      repo: "runtimeverification/k" as const,
      release,
      path: IO_CPP_IDENTITY.gitlinkPath,
      commit: gitlink,
    };
    if (bytes === undefined) {
      files.push({
        repo: IO_CPP_IDENTITY.repo,
        path: IO_CPP_IDENTITY.path,
        revision: gitlink,
        tier: "reference",
        status: "missing",
        expected: IO_CPP_IDENTITY.sha256,
        why: IO_CPP_IDENTITY.why,
        resolvedFrom,
      });
    } else {
      const actual = await sha256Hex(bytes);
      files.push({
        repo: IO_CPP_IDENTITY.repo,
        path: IO_CPP_IDENTITY.path,
        revision: gitlink,
        tier: "reference",
        status: actual === IO_CPP_IDENTITY.sha256 ? "unchanged" : "changed",
        expected: IO_CPP_IDENTITY.sha256,
        actual,
        why: IO_CPP_IDENTITY.why,
        resolvedFrom,
      });
    }
  }

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
