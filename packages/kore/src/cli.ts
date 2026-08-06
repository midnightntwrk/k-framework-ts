/**
 * `kore check-k <k-release> [<haskell-backend-release>]` — does this
 * transcription still hold at that K release?
 *
 * Same contract as kast-json's `check-k` (see that package and
 * `docs/versioning.md`), with the two KORE-specific twists:
 *
 * - The sources span two repositories. If the haskell-backend release is not
 *   given, it is resolved from the k repo itself: the GitHub contents API
 *   reports the submodule commit that the requested k tag pins at
 *   `haskell-backend/src/main/native/haskell-backend`, and raw.githubusercontent
 *   serves files at a bare commit SHA just as it does at a tag.
 * - Verdicts are per tier. The exit code reflects the **format** tier only;
 *   `content` drift (`ModuleToKORE.java`, which decides what `kompile` emits,
 *   not what KORE is) is printed as advisory. See `version.ts`.
 *
 * Everything here is a pure function of its arguments — argv, two sinks, and
 * fetchers — so the command is tested offline. `bin.ts` is the only file that
 * touches `process`.
 */

import {
  checkKoreSources,
  type KoreSourceFetcher,
  type KoreSourcesReport,
  type KoreSourcesVerdict,
} from "./ksources.js";
import { K_RELEASE } from "./version.js";

const RAW = "https://raw.githubusercontent.com";
const API = "https://api.github.com";
const SUBMODULE_PATH = "haskell-backend/src/main/native/haskell-backend";

export const USAGE = `kore check-k <k-release> [<haskell-backend-release>]

Check whether the upstream sources this package was transcribed from are
unchanged at a given K release:

  kore check-k v7.1.337

The haskell-backend tree is checked at the submodule commit that k release
pins, unless a second release/commit is given explicitly.

Exit codes reflect the format tier (grammar, codecs, pyk sources): 0 unchanged,
1 changed, 3 could not locate, 2 could not run. Drift in the content tier
(ModuleToKORE.java — what kompile emits, not what KORE is) is advisory and
does not affect the exit code.`;

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
  json(): Promise<unknown>;
}

type FetchLike = (url: string) => Promise<ResponseLike>;

function theFetch(): FetchLike {
  // See `ksources.ts` for why a global is reached by assertion rather than by
  // an ambient declaration.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return (globalThis as unknown as { fetch: FetchLike }).fetch;
}

/** Fetches from GitHub raw. A 404 is "not at this tag"; anything else throws. */
export const fetchFromGitHub: KoreSourceFetcher = async (repo, path, release) => {
  const response = await theFetch()(`${RAW}/${repo}/${encodeURIComponent(release)}/${path}`);
  // Only a clean 404 means "not at this tag". Anything else is a failure to
  // ask, which must not be reported as a fact about upstream.
  if (!response.ok && response.status !== 404) {
    throw new Error(`GET ${repo}/${path} at ${release}: HTTP ${response.status} ${response.statusText}`);
  }
  return response.status === 404 ? undefined : new Uint8Array(await response.arrayBuffer());
};

/**
 * The submodule commit `runtimeverification/k` pins at `kRelease`, via the
 * GitHub contents API (`type: "submodule"`, `sha` is the pinned commit).
 * `undefined` when the path does not exist at that tag.
 */
export type SubmoduleResolver = (kRelease: string) => Promise<string | undefined>;

export const resolveSubmoduleFromGitHub: SubmoduleResolver = async (kRelease) => {
  const url = `${API}/repos/runtimeverification/k/contents/${SUBMODULE_PATH}?ref=${encodeURIComponent(kRelease)}`;
  const response = await theFetch()(url);
  if (response.status === 404) return undefined;
  if (!response.ok) {
    throw new Error(`GET submodule pin at ${kRelease}: HTTP ${response.status} ${response.statusText}`);
  }
  const body = await response.json();
  if (typeof body !== "object" || body === null || !("sha" in body) || typeof body.sha !== "string") {
    throw new Error(`GET submodule pin at ${kRelease}: response carried no sha`);
  }
  return body.sha;
};

function summaryFor(verdict: KoreSourcesVerdict, what: string): string {
  return verdict === "unchanged"
    ? `${what}: unchanged — the transcription is current.`
    : verdict === "changed"
      ? `${what}: CHANGED — diff the files above before trusting this package there.`
      : `${what}: could not locate a path — the check cannot answer; the manifest needs re-establishing.`;
}

export function render(report: KoreSourcesReport): string {
  const tierOf = (tier: "format" | "content"): string => {
    const lines = report.files
      .filter((f) => f.tier === tier)
      .map((file) => {
        const mark = file.status === "unchanged" ? "ok  " : file.status === "changed" ? "DIFF" : "GONE";
        const release = file.repo === "runtimeverification/k" ? report.releases.k : report.releases.haskellBackend;
        const detail =
          file.status === "unchanged"
            ? "unchanged"
            : file.status === "changed"
              ? `expected ${file.expected.slice(0, 12)}…, got ${(file.actual ?? "").slice(0, 12)}…`
              : `no such path at ${release}`;
        return `  ${mark}  ${file.repo}:${file.path}\n        ${detail}`;
      });
    return lines.join("\n");
  };

  return (
    `format tier (what KORE is):\n${tierOf("format")}\n\n` +
    `content tier (what kompile emits — advisory):\n${tierOf("content")}\n\n` +
    `${summaryFor(report.verdicts.format, "format")}\n` +
    `${summaryFor(report.verdicts.content, "content (advisory)")}\n`
  );
}

/** Maps the format-tier verdict to this command's contractual exit code. */
export function exitCodeFor(verdict: KoreSourcesVerdict): number {
  return verdict === "unchanged" ? 0 : verdict === "changed" ? 1 : 3;
}

export async function main(
  argv: readonly string[],
  out: (text: string) => void,
  err: (text: string) => void,
  fetcher: KoreSourceFetcher = fetchFromGitHub,
  resolveSubmodule: SubmoduleResolver = resolveSubmoduleFromGitHub,
): Promise<number> {
  const [command, kRelease, hbRelease, ...rest] = argv;

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
  if (kRelease === undefined || rest.length > 0) {
    err(`check-k takes a K release tag (e.g. ${K_RELEASE}) and optionally a haskell-backend release\n\n${USAGE}\n`);
    return 2;
  }

  let report: KoreSourcesReport;
  try {
    let haskellBackend = hbRelease;
    if (haskellBackend === undefined) {
      haskellBackend = await resolveSubmodule(kRelease);
      if (haskellBackend === undefined) {
        // The submodule path is itself part of what we recorded; if K moved
        // it, the check cannot answer — same three-valued honesty as GONE.
        err(
          `K ${kRelease} has no submodule at ${SUBMODULE_PATH}, so the haskell-backend\n` +
            `release cannot be resolved. Pass it explicitly if you know it.\n`,
        );
        return 3;
      }
      out(`haskell-backend pinned by K ${kRelease}: ${haskellBackend}\n\n`);
    }
    report = await checkKoreSources({ k: kRelease, haskellBackend }, fetcher);
  } catch (error) {
    // Failing to reach GitHub is "could not ask", which is neither a pass nor
    // a fail — reporting it as either would be a lie about upstream.
    err(`could not check ${kRelease}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  out(render(report));
  return exitCodeFor(report.verdicts.format);
}
