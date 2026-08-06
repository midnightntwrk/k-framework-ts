/** `kcfg check-k <k-release>` — check the recorded pyk sources against K. */

import {
  checkKcfgSources,
  type KcfgSourceFetcher,
  type KcfgSourcesReport,
  type KcfgSourcesVerdict,
} from "./ksources.js";
import { K_RELEASE } from "./version.js";

const RAW = "https://raw.githubusercontent.com/runtimeverification/k";

export const USAGE = `kcfg check-k <k-release>

Check whether the pyk KCFG sources this package was transcribed from are
unchanged at a given K release:

  kcfg check-k v7.1.337

Exit codes: 0 unchanged, 1 changed, 3 could not locate, 2 could not run.`;

interface ResponseLike {
  readonly status: number;
  readonly ok: boolean;
  readonly statusText: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** Fetch a declared source from GitHub; only a clean 404 means it moved. */
export const fetchFromGitHub: KcfgSourceFetcher = async (path, release) => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const { fetch } = globalThis as unknown as { fetch: (url: string) => Promise<ResponseLike> };
  const response = await fetch(`${RAW}/${encodeURIComponent(release)}/${path}`);
  if (!response.ok && response.status !== 404) {
    throw new Error(`GET ${path} at ${release}: HTTP ${response.status} ${response.statusText}`);
  }
  return response.status === 404 ? undefined : new Uint8Array(await response.arrayBuffer());
};

/** Render a source-drift result for both the terminal and CI logs. */
export function render(report: KcfgSourcesReport): string {
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
export function exitCodeFor(verdict: KcfgSourcesVerdict): number {
  return verdict === "unchanged" ? 0 : verdict === "changed" ? 1 : 3;
}

/** CLI core, with injected I/O and fetcher so it can be tested offline. */
export async function main(
  argv: readonly string[],
  out: (text: string) => void,
  err: (text: string) => void,
  fetcher: KcfgSourceFetcher = fetchFromGitHub,
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
  try {
    const report = await checkKcfgSources(release, fetcher);
    out(render(report));
    return exitCodeFor(report.verdict);
  } catch (error) {
    err(`could not check ${release}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}
