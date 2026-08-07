/**
 * The `kompiled` command: two subcommands, both pure functions of their
 * arguments plus injected effects, so both are tested without spawning a
 * process.  `bin.ts` is the only file here that touches `process`.
 *
 * - `kompiled info <dir>` — say everything a kompiled directory says about
 *   itself, without parsing a single term.  This is the command that answers
 *   "what is this directory, and can this library read it?", and it is
 *   deliberately cheap: it reads four small files and `stat`s a fifth.
 *   `--artifacts` adds a presence/size line per big artifact, which costs one
 *   `stat` each and still parses nothing.
 * - `kompiled check-k <k-release>` — the `ksources.ts` drift check, with the
 *   same contract as its siblings: the exit code reflects the **format** tier,
 *   and content-tier drift (the Java producers and the layout README) is
 *   printed as advisory, because the layout has no version and K itself says it
 *   may change without warning.
 */

import { stat } from "node:fs/promises";
import { join } from "node:path";
import { KompiledError } from "./errors.js";
import { inspectBisonParserArtifacts, loadKompiledLayout, type BisonParserArtifactInspection } from "./fs.js";
import type { KompiledLayout } from "./layout.js";
import {
  checkKompiledSources,
  type KompiledSourceFetcher,
  type KompiledSourcesReport,
  type KompiledSourcesVerdict,
} from "./ksources.js";
import { K_RELEASE, OBSERVED_LAYOUT } from "./version.js";

const RAW = "https://raw.githubusercontent.com";

export const USAGE = `kompiled <command>

  kompiled info <dir> [--artifacts]
      Describe a *-kompiled directory: backend, main module, syntax module,
      timestamp mtime, configuration variables, allRules.txt entry count.
      Parses no terms. --artifacts also reports which large artifacts exist.

  kompiled check-k <k-release>
      Check whether the upstream sources this package was transcribed from are
      unchanged at a given K release, e.g. kompiled check-k ${K_RELEASE}.

Exit codes for check-k reflect the format tier (the pyk behaviour this package
reimplements): 0 unchanged, 1 changed, 3 could not locate, 2 could not run.
Drift in the content tier (the Java producers, and the README kompile copies
into every kompiled directory) is advisory and does not affect the exit code —
that layout has no version number, and K says it may change without warning.

info exits 0 on success and 1 on an unreadable directory.`;

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

type FetchLike = (url: string) => Promise<ResponseLike>;

function theFetch(): FetchLike {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return (globalThis as unknown as { fetch: FetchLike }).fetch;
}

/** Fetches from GitHub raw.  A 404 is "not at this tag"; anything else throws. */
export const fetchFromGitHub: KompiledSourceFetcher = async (repo, path, release) => {
  const response = await theFetch()(`${RAW}/${repo}/${encodeURIComponent(release)}/${path}`);
  if (!response.ok && response.status !== 404) {
    throw new Error(`GET ${repo}/${path} at ${release}: HTTP ${response.status} ${response.statusText}`);
  }
  return response.status === 404 ? undefined : new Uint8Array(await response.arrayBuffer());
};

//////////////////////////////
// info                     //
//////////////////////////////

/** One artifact's presence and size, for `--artifacts`. */
export interface ArtifactStatus {
  readonly file: string;
  readonly bytes: number | undefined;
  readonly note: string;
}

/** `stat` every artifact this package reads.  Never opens one. */
export function artifactStatuses(dir: string): Promise<readonly ArtifactStatus[]> {
  return Promise.all(
    OBSERVED_LAYOUT.filter((artifact) => artifact.status === "read").map(async (artifact) => {
      const bytes = await stat(join(dir, artifact.file))
        .then((stats) => (stats.isFile() ? stats.size : undefined))
        .catch(() => undefined);
      return { file: artifact.file, bytes, note: artifact.note };
    }),
  );
}

/** Render a {@link KompiledLayout} as the `info` command's report. */
export function renderInfo(
  dir: string,
  layout: KompiledLayout,
  artifacts?: readonly ArtifactStatus[],
  parserArtifacts?: readonly BisonParserArtifactInspection[],
): string {
  const lines = [
    `directory          ${dir}`,
    `backend            ${layout.backend}`,
    `main module        ${layout.mainModule}`,
    `syntax module      ${layout.mainSyntaxModule}`,
    // The mtime, never the content: `timestamp` is seven bytes of Java
    // serialization and says nothing.  It is written last, so it post-dates
    // every other artifact in the directory.
    `timestamp mtime    ${new Date(layout.timestampMtimeMs).toISOString()} (${layout.timestampMtimeMs} ms)`,
    `config variables   ${layout.configVars.length === 0 ? "(none)" : layout.configVars.join(", ")}`,
  ];
  for (const name of layout.configVars) {
    const sort = layout.configVarSorts.get(name);
    if (sort !== undefined) lines.push(`  $${name}${" ".repeat(Math.max(1, 16 - name.length))} ${sort}`);
  }
  for (const [name, module] of layout.configVarModules) lines.push(`  parser ${name} -> ${module}`);
  lines.push(
    `allRules.txt       ${layout.allRules.size} rule${layout.allRules.size === 1 ? "" : "s"} ` +
      "(main-module rules carrying Source, Location and UNIQUE_ID only)",
  );

  if (artifacts !== undefined) {
    lines.push("", "artifacts:");
    for (const artifact of artifacts) {
      const size = artifact.bytes === undefined ? "absent" : `${artifact.bytes} B`;
      lines.push(`  ${artifact.file.padEnd(22)} ${size.padStart(10)}  ${artifact.note}`);
    }
  }

  if (parserArtifacts !== undefined) {
    lines.push("", "parser artifacts (expected; passive — not executable checks):");
    for (const inspection of parserArtifacts) {
      if ("executablePath" in inspection) {
        const forms = [
          inspection.executablePath === undefined ? undefined : inspection.artifact.executable,
          inspection.libraryPath === undefined ? undefined : inspection.artifact.library,
        ].filter((name): name is string => name !== undefined);
        lines.push(
          `  ${inspection.artifact.executable.padEnd(22)} ${(forms.length === 0 ? inspection.status : forms.join(", ")).padStart(10)}`,
        );
      } else {
        const detail =
          inspection.status === "target"
            ? `${inspection.target}${inspection.diagnostic === undefined ? "" : ` (unexpected; expected ${inspection.diagnostic.expected.join(" or ")})`}`
            : inspection.status;
        lines.push(`  ${inspection.artifact.file.padEnd(22)} ${detail}`);
      }
    }
  }

  return `${lines.join("\n")}\n`;
}

//////////////////////////////
// check-k                  //
//////////////////////////////

function summaryFor(verdict: KompiledSourcesVerdict, what: string): string {
  return verdict === "unchanged"
    ? `${what}: unchanged — the transcription is current.`
    : verdict === "changed"
      ? `${what}: CHANGED — diff the files above before trusting this package there.`
      : `${what}: could not locate a path — the check cannot answer; the manifest needs re-establishing.`;
}

export function render(report: KompiledSourcesReport): string {
  const tierOf = (tier: "format" | "content"): string =>
    report.files
      .filter((f) => f.tier === tier)
      .map((file) => {
        const mark = file.status === "unchanged" ? "ok  " : file.status === "changed" ? "DIFF" : "GONE";
        const detail =
          file.status === "unchanged"
            ? "unchanged"
            : file.status === "changed"
              ? `expected ${file.expected.slice(0, 12)}…, got ${(file.actual ?? "").slice(0, 12)}…`
              : `no such path at ${report.release}`;
        return `  ${mark}  ${file.path}\n        ${detail}\n        ${file.why}`;
      })
      .join("\n");

  return (
    `format tier (the pyk behaviour this package reimplements):\n${tierOf("format")}\n\n` +
    `content tier (what kompile writes into the directory — advisory):\n${tierOf("content")}\n\n` +
    `${summaryFor(report.verdicts.format, "format")}\n` +
    `${summaryFor(report.verdicts.content, "content (advisory)")}\n`
  );
}

/** Maps the format-tier verdict to this command's contractual exit code. */
export function exitCodeFor(verdict: KompiledSourcesVerdict): number {
  return verdict === "unchanged" ? 0 : verdict === "changed" ? 1 : 3;
}

//////////////////////////////
// Entry point              //
//////////////////////////////

export function main(
  argv: readonly string[],
  out: (text: string) => void,
  err: (text: string) => void,
  fetcher: KompiledSourceFetcher = fetchFromGitHub,
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
  if (command === "info") return mainInfo(args, out, err);
  if (command === "check-k") return mainCheckK(args, out, err, fetcher);
  err(`unknown command: ${command}\n\n${USAGE}\n`);
  return Promise.resolve(2);
}

async function mainInfo(
  args: readonly string[],
  out: (text: string) => void,
  err: (text: string) => void,
): Promise<number> {
  const wantArtifacts = args.includes("--artifacts");
  const positional = args.filter((arg) => arg !== "--artifacts");
  const [dir, ...rest] = positional;
  if (dir === undefined || rest.length > 0) {
    err(`info takes exactly one directory\n\n${USAGE}\n`);
    return 2;
  }

  try {
    const layout = await loadKompiledLayout(dir);
    out(
      renderInfo(
        dir,
        layout,
        wantArtifacts ? await artifactStatuses(dir) : undefined,
        wantArtifacts ? await inspectBisonParserArtifacts(dir, layout) : undefined,
      ),
    );
    return 0;
  } catch (error) {
    // A KompiledError already says what to do about it; anything else is a
    // real I/O failure and its own message is the best available.
    err(`${error instanceof KompiledError || error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function mainCheckK(
  args: readonly string[],
  out: (text: string) => void,
  err: (text: string) => void,
  fetcher: KompiledSourceFetcher,
): Promise<number> {
  const [release, ...rest] = args;
  if (release === undefined || rest.length > 0) {
    err(`check-k takes a K release tag (e.g. ${K_RELEASE})\n\n${USAGE}\n`);
    return 2;
  }

  let report: KompiledSourcesReport;
  try {
    report = await checkKompiledSources(release, fetcher);
  } catch (error) {
    // Failing to reach GitHub is "could not ask", which is neither a pass nor
    // a fail — reporting it as either would be a lie about upstream.
    err(`could not check ${release}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  out(render(report));
  return exitCodeFor(report.verdicts.format);
}
