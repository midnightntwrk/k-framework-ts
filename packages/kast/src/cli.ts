/**
 * `kast check-k <k-release>` — does this transcription still hold at that K
 * release?
 *
 * Fetches the files recorded in `TRANSCRIBED_FROM` from GitHub at the requested
 * tag and compares hashes.  It works for any tag, including releases published
 * after this package was, which is the whole point: `docs/versioning.md` records
 * why a declared "verified through vX" range was rejected in favour of asking on
 * demand.
 *
 * Everything here is a pure function of its arguments — argv, two sinks, and a
 * fetcher — so the command is tested offline.  `bin.ts` is the only file that
 * touches `process`.
 */

import { checkKSources, type KSourceFetcher, type KSourcesReport } from "./ksources.js";
import { K_RELEASE } from "./version.js";

const RAW = "https://raw.githubusercontent.com/runtimeverification/k";

export const USAGE = `kast check-k <k-release>

Check whether the pyk sources this package was transcribed from are unchanged
at a given K release:

  kast check-k v7.1.400

Exit codes: 0 unchanged, 1 changed, 3 could not locate, 2 could not run.`;

/**
 * `fetch`, reached through `globalThis` for the same reason as Web Crypto in
 * `ksources.ts`: the emit config has no ambient DOM types, and naming one here
 * would collide with Bun's under the development config.
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

export function render(report: KSourcesReport): string {
  const lines = report.files.map((file) => {
    const mark = file.status === "unchanged" ? "ok  " : file.status === "changed" ? "DIFF" : "GONE";
    const detail =
      file.status === "unchanged"
        ? `unchanged since ${report.recordedAt}`
        : file.status === "changed"
          ? `expected ${file.expected.slice(0, 12)}…, got ${(file.actual ?? "").slice(0, 12)}…`
          : `no such path at ${report.release}`;
    return `  ${mark}  ${file.path}\n        ${detail}`;
  });

  const summary =
    report.verdict === "unchanged"
      ? `This package's transcription is current for K ${report.release}.`
      : report.verdict === "changed"
        ? `A source this package transcribes changed between ${report.recordedAt} and ${report.release}.\n` +
          `Diff it before trusting this package at that release.`
        : `K moved a path between ${report.recordedAt} and ${report.release}, so this check cannot\n` +
          `answer. That is not a verdict about compatibility — the manifest needs re-establishing.`;

  return `${lines.join("\n")}\n\n${summary}\n`;
}

/** Maps a verdict to this command's contractual exit code. */
export function exitCodeFor(verdict: KSourcesReport["verdict"]): number {
  return verdict === "unchanged" ? 0 : verdict === "changed" ? 1 : 3;
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

  let report: KSourcesReport;
  try {
    report = await checkKSources(release, fetcher);
  } catch (error) {
    // Failing to reach GitHub is "could not ask", which is neither a pass nor a
    // fail — reporting it as either would be a lie about K.
    err(`could not check ${release}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  out(render(report));
  return exitCodeFor(report.verdict);
}
