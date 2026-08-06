/**
 * `kast-json check-k <k-release>` — which of this package's transcriptions
 * does that K release speak?
 *
 * Fetches the files recorded in `TRANSCRIBED_FROM` (plus the shared
 * `ADT.scala` sort spelling) from GitHub at the requested tag and compares
 * hashes against every recorded revision.  It works for any tag, including
 * releases published after this package was, which is the whole point:
 * `docs/versioning.md` records why a declared "verified through vX" range was
 * rejected in favour of asking on demand.
 *
 * Everything here is a pure function of its arguments — argv, two sinks, and a
 * fetcher — so the command is tested offline.  `bin.ts` is the only file that
 * touches `process`.
 */

import { checkKRevisions, type KSourceFetcher, type KRevisionsReport } from "./ksources.js";
import { K_RELEASE } from "./version.js";

const RAW = "https://raw.githubusercontent.com/runtimeverification/k";

export const USAGE = `kast-json check-k <k-release>

Check which KAST JSON version a given K release emits, by comparing the K
sources this package was transcribed from against that release:

  kast-json check-k v7.1.240

Exit codes: 0 release matches a transcribed revision, 1 sources changed,
3 could not locate a source path, 2 could not run.`;

/**
 * `fetch`, reached through `globalThis` for the same reason as Web Crypto in
 * `ksources.ts`: the emit config has no ambient DOM or Node types, and naming
 * one here would collide with Bun's under the development config.
 */
interface ResponseLike {
  readonly status: number;
  readonly ok: boolean;
  readonly statusText: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** Fetches from GitHub raw. A 404 is "not at this tag"; anything else throws. */
export const fetchFromGitHub: KSourceFetcher = async (path, release) => {
  // See `ksources.ts` for why a global is reached by assertion rather than by
  // an ambient declaration.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const { fetch } = globalThis as unknown as { fetch: (url: string) => Promise<ResponseLike> };
  const response = await fetch(`${RAW}/${encodeURIComponent(release)}/${path}`);
  // Only a clean 404 means "not at this tag". Anything else is a failure to
  // ask, which must not be reported as a fact about K.
  if (!response.ok && response.status !== 404) {
    throw new Error(`GET ${path} at ${release}: HTTP ${response.status} ${response.statusText}`);
  }
  return response.status === 404 ? undefined : new Uint8Array(await response.arrayBuffer());
};

/** `v7.1.320 – v7.1.337`, or `v7.1.320 onward` for the open-ended newest. */
function span(revision: KRevisionsReport["revisions"][number]["revision"]): string {
  return revision.lastRelease === undefined
    ? `${revision.firstRelease} onward`
    : `${revision.firstRelease} – ${revision.lastRelease}`;
}

export function render(report: KRevisionsReport): string {
  const revisionLines = report.revisions.map(({ revision, matches }) => {
    const mark = matches ? "MATCH" : "  no ";
    return `  ${mark}  KAST v${revision.kastVersion} (${span(revision)}, recorded at ${revision.recordedAt})`;
  });

  const fileLines = report.files.map((file) =>
    file.actual === undefined
      ? `  GONE  ${file.path}\n        no such path at ${report.release}`
      : `  ok    ${file.path}\n        sha256 ${file.actual.slice(0, 12)}…`,
  );

  const summary =
    report.verdict === "matched"
      ? `K ${report.release} emits KAST v${report.matched?.kastVersion}; this package's transcription is current for it.`
      : report.verdict === "changed"
        ? `The K sources this package transcribes match none of its recorded revisions at\n` +
          `${report.release}. Diff them before trusting this package at that release.`
        : `K moved a source path, so this check cannot answer for ${report.release}. That is\n` +
          `not a verdict about compatibility — the manifest needs re-establishing.`;

  return `${revisionLines.join("\n")}\n\n${fileLines.join("\n")}\n\n${summary}\n`;
}

/** Maps a verdict to this command's contractual exit code. */
export function exitCodeFor(verdict: KRevisionsReport["verdict"]): number {
  return verdict === "matched" ? 0 : verdict === "changed" ? 1 : 3;
}

export async function main(
  argv: readonly string[],
  out: (text: string) => void,
  err: (text: string) => void,
  fetcher: KSourceFetcher = fetchFromGitHub,
): Promise<number> {
  const [command, release, ...rest] = argv;

  if (command === undefined) {
    err(`${USAGE}\n`);
    return 2;
  }
  if (command === "--help" || command === "-h" || command === "help") {
    out(`${USAGE}\n`);
    return 0;
  }
  if (command !== "check-k") {
    err(`unknown command: ${command}\n\n${USAGE}\n`);
    return 2;
  }
  if (release === undefined || rest.length > 0) {
    err(`check-k takes exactly one K release tag, e.g. ${K_RELEASE}\n\n${USAGE}\n`);
    return 2;
  }

  let report: KRevisionsReport;
  try {
    report = await checkKRevisions(release, fetcher);
  } catch (error) {
    // Failing to reach GitHub is "could not ask", which is neither a pass nor a
    // fail — reporting it as either would be a lie about K.
    err(`could not check ${release}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  out(render(report));
  return exitCodeFor(report.verdict);
}
