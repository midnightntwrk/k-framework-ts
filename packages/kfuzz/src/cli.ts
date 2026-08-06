/**
 * The `kfuzz` command — the house `check-k` drift check, and nothing else.
 *
 * There is deliberately no `kfuzz run` subcommand.  A fuzz run is defined by a
 * KORE template with variables in it and one arbitrary per variable; neither has
 * a text encoding a flag could carry, and inventing one would be inventing a
 * second, worse, way to write a `fast-check` generator.  `docs/gap-analysis.md`
 * S5 settles the general form of this question for the repo: our operators are
 * agents and TypeScript programs calling libraries, and any CLI shipped here is
 * a thin bin over a typed options object.  For fuzzing there is no such object
 * that a shell can construct, so the library is the interface.
 */

import {
  checkKfuzzSources,
  type KfuzzSourceFetcher,
  type KfuzzSourcesReport,
  type KfuzzSourcesVerdict,
} from "./ksources.js";
import { K_RELEASE } from "./version.js";

const RAW = "https://raw.githubusercontent.com/runtimeverification/k";

export const USAGE = `kfuzz <command>

  kfuzz check-k <k-release>
      Check whether the pyk sources this package was transcribed from are
      unchanged at a given K release, e.g. kfuzz check-k ${K_RELEASE}.

There is no subcommand that runs a fuzzer: a template pattern and a set of
fast-check arbitraries have no command-line encoding. Import the library.

Exit codes: 0 unchanged, 1 changed, 3 could not locate, 2 could not run.`;

interface ResponseLike {
  readonly status: number;
  readonly ok: boolean;
  readonly statusText: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** Fetch a declared source from GitHub; only a clean 404 means it moved. */
export const fetchFromGitHub: KfuzzSourceFetcher = async (path, release) => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const { fetch } = globalThis as unknown as { fetch: (url: string) => Promise<ResponseLike> };
  const response = await fetch(`${RAW}/${encodeURIComponent(release)}/${path}`);
  if (!response.ok && response.status !== 404) {
    throw new Error(`GET ${path} at ${release}: HTTP ${response.status} ${response.statusText}`);
  }
  return response.status === 404 ? undefined : new Uint8Array(await response.arrayBuffer());
};

/** Render a source-drift result for both a terminal and a CI log. */
export function render(report: KfuzzSourcesReport): string {
  const files = report.files.map((file) => {
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
        : `K moved a source path, so this check cannot answer for ${report.release}. That is\n` +
          `not a verdict about compatibility — the manifest needs re-establishing.`;
  return `${files.join("\n")}\n\n${summary}\n`;
}

/** Map the repository-wide `check-k` verdict contract to process exit codes. */
export function exitCodeFor(verdict: KfuzzSourcesVerdict): number {
  return verdict === "unchanged" ? 0 : verdict === "changed" ? 1 : 3;
}

async function mainCheckK(
  args: readonly string[],
  out: (text: string) => void,
  err: (text: string) => void,
  fetcher: KfuzzSourceFetcher,
): Promise<number> {
  const [release, ...rest] = args;
  if (release === undefined || rest.length > 0) {
    err(`check-k takes exactly one K release tag, e.g. ${K_RELEASE}\n\n${USAGE}\n`);
    return 2;
  }
  try {
    const report = await checkKfuzzSources(release, fetcher);
    out(render(report));
    return exitCodeFor(report.verdict);
  } catch (error) {
    err(`could not check ${release}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

/** CLI core, with injected I/O and fetcher so `check-k` can be tested offline. */
export function main(
  argv: readonly string[],
  out: (text: string) => void,
  err: (text: string) => void,
  fetcher: KfuzzSourceFetcher = fetchFromGitHub,
): Promise<number> {
  const [command, ...args] = argv;

  if (command === undefined) {
    err(`${USAGE}\n`);
    return Promise.resolve(2);
  }
  if (command === "--help" || command === "-h" || command === "help") {
    out(`${USAGE}\n`);
    return Promise.resolve(0);
  }
  if (command === "check-k") return mainCheckK(args, out, err, fetcher);

  err(`unknown command: ${command}\n\n${USAGE}\n`);
  return Promise.resolve(2);
}
