/**
 * `konvert check-k <k-release>` — does this transcription still hold at that K
 * release?
 *
 * Same contract as `kast`'s and `kore`'s `check-k` (see those packages and
 * `docs/versioning.md`), with this package's twist: verdicts are **per tier**,
 * and the exit code reflects the `format` tier only. `content` drift — the
 * Java/Scala originals pyk re-implements — is printed as advisory. See
 * `version.ts` for the tier rationale.
 *
 * Everything here is a pure function of its arguments — argv, two sinks, and a
 * fetcher — so the command is tested offline. `bin.ts` is the only file that
 * touches `process`.
 */

import {
  checkKonvertSources,
  type KonvertSourceFetcher,
  type KonvertSourcesReport,
  type KonvertSourcesVerdict,
} from "./ksources.js";
import { K_RELEASE } from "./version.js";

const RAW = "https://raw.githubusercontent.com/runtimeverification/k";

export const USAGE = `konvert check-k <k-release>

Check whether the upstream sources this package was transcribed from are
unchanged at a given K release:

  konvert check-k ${K_RELEASE}

Exit codes reflect the format tier (pyk's konvert/*.py): 0 unchanged,
1 changed, 3 could not locate, 2 could not run. Drift in the content tier
(ModuleToKORE.java, KoreToK.scala — the originals pyk re-implements) is
advisory and does not affect the exit code.`;

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
export const fetchFromGitHub: KonvertSourceFetcher = async (path, release) => {
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

function summaryFor(verdict: KonvertSourcesVerdict, what: string): string {
  return verdict === "unchanged"
    ? `${what}: unchanged — the transcription is current.`
    : verdict === "changed"
      ? `${what}: CHANGED — diff the files above before trusting this package there.`
      : `${what}: could not locate a path — the check cannot answer; the manifest needs re-establishing.`;
}

export function render(report: KonvertSourcesReport): string {
  const tierOf = (tier: "format" | "content"): string => {
    const lines = report.files
      .filter((f) => f.tier === tier)
      .map((file) => {
        const mark = file.status === "unchanged" ? "ok  " : file.status === "changed" ? "DIFF" : "GONE";
        const detail =
          file.status === "unchanged"
            ? `unchanged since ${report.recordedAt}`
            : file.status === "changed"
              ? `expected ${file.expected.slice(0, 12)}…, got ${(file.actual ?? "").slice(0, 12)}…`
              : `no such path at ${report.release}`;
        return `  ${mark}  ${file.path}\n        ${detail}`;
      });
    return lines.join("\n");
  };

  return (
    `format tier — pyk's konvert/, what this package transcribes:\n${tierOf("format")}\n\n` +
    `content tier — the Java/Scala originals, advisory:\n${tierOf("content")}\n\n` +
    `${summaryFor(report.verdicts.format, "format")}\n` +
    `${summaryFor(report.verdicts.content, "content (advisory)")}\n`
  );
}

/** Maps the `format` verdict to this command's contractual exit code. */
export function exitCodeFor(verdict: KonvertSourcesVerdict): number {
  return verdict === "unchanged" ? 0 : verdict === "changed" ? 1 : 3;
}

export async function main(
  argv: readonly string[],
  out: (text: string) => void,
  err: (text: string) => void,
  fetcher: KonvertSourceFetcher = fetchFromGitHub,
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

  let report: KonvertSourcesReport;
  try {
    report = await checkKonvertSources(release, fetcher);
  } catch (error) {
    // Failing to reach GitHub is "could not ask", which is neither a pass nor a
    // fail — reporting it as either would be a lie about K.
    err(`could not check ${release}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  out(render(report));
  return exitCodeFor(report.verdicts.format);
}
