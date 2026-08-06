/**
 * The `klean` command, with filesystem effects injected for unit testing.
 *
 * Two commands share this entry point:
 *
 * - the generator, `klean DEFN_DIR PKG_NAME`, which is what the package is for;
 * - `klean check-k <k-release>`, the house drift check over `ksources.ts`, which
 *   every package that transcribes K sources exposes (`docs/versioning.md:63`).
 *
 * Both are pure functions of their arguments plus injected effects — the
 * filesystem seam for the generator, a fetcher for `check-k` — so both are
 * tested without a process, a disk, or a network; `bin.ts` is the only file
 * here that touches `process`.
 */

import { readFile } from "node:fs/promises";

import { generateKleanProject, type GeneratedProject, type KleanOptions } from "./generate.js";
import { KleanOutputExistsError, writeKleanProject } from "./fs.js";
import {
  checkKleanSources,
  type KleanSourceFetcher,
  type KleanSourcesReport,
  type KleanSourcesVerdict,
} from "./ksources.js";
import { sourceFromKoreText } from "./source.js";
import { K_RELEASE } from "./version.js";

const RAW = "https://raw.githubusercontent.com/runtimeverification/k";

export const USAGE = `klean DEFN_DIR PKG_NAME [options]

Generate a Lean 4 Lake project from DEFN_DIR/definition.kore.

  -o, --output DIR          parent output directory (default: .)
  -l, --library NAME        Lean library name (default: package in PascalCase)
  -r, --rule LABEL          include exactly this rewrite and its dependencies;
                            repeat to select multiple rules (default: all)
      --derive-beq          derive BEq for generated sorts
      --derive-decidableeq  derive DecidableEq except for SortKItem dependents
      --no-manifest         do not write klean-manifest.json
  -h, --help                show this help

klean check-k <k-release>

Check whether the pyk.klean sources this package was transcribed from are
unchanged at a given K release, e.g. klean check-k ${K_RELEASE}. A directory
named exactly 'check-k' is still generatable as './check-k'.

The compiler never invokes kompile or Lean. It refuses to write incomplete
output when generation reports an error.

Exit codes: 0 success, 1 input/generation/write failure, 2 usage, 115 output
directory already exists. For check-k: 0 unchanged, 1 changed, 3 could not
locate a path at that release, 2 could not run. The two contracts do not
overlap — check-k writes nothing, so it never returns 115, and generation
fetches nothing, so it never returns 3.`;

export interface KleanCliEffects {
  readText(path: string): Promise<string>;
  writeProject(project: GeneratedProject, outputDirectory: string, manifest: boolean): Promise<string>;
}

export const NODE_KLEAN_CLI_EFFECTS: KleanCliEffects = {
  readText: (path) => readFile(path, "utf8"),
  writeProject: (project, outputDirectory, manifest) => writeKleanProject(project, outputDirectory, { manifest }),
};

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

/**
 * Fetches from GitHub raw. A 404 is "not at this tag"; anything else throws.
 *
 * Each path segment is encoded, which siblings do not need to do: three of the
 * declared sources are cookiecutter template paths carrying spaces and braces
 * (`version.ts`' `TRANSCRIBED_FROM`), and those must not be handed to `fetch`
 * as raw URL text. `test/cli.test.ts` pins the resulting URL.
 */
export const fetchFromGitHub: KleanSourceFetcher = async (path, release) => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const { fetch } = globalThis as unknown as { fetch: (url: string) => Promise<ResponseLike> };
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const response = await fetch(`${RAW}/${encodeURIComponent(release)}/${encoded}`);
  // Only a clean 404 means "not at this tag". Anything else is a failure to
  // ask, which must not be reported as a fact about K.
  if (!response.ok && response.status !== 404) {
    throw new Error(`GET ${path} at ${release}: HTTP ${response.status} ${response.statusText}`);
  }
  return response.status === 404 ? undefined : new Uint8Array(await response.arrayBuffer());
};

interface ParsedArgs extends KleanOptions {
  readonly definitionDirectory: string;
  readonly outputDirectory: string;
  readonly manifest: boolean;
}

export async function main(
  argv: readonly string[],
  out: (text: string) => void,
  err: (text: string) => void,
  effects: KleanCliEffects = NODE_KLEAN_CLI_EFFECTS,
  fetcher: KleanSourceFetcher = fetchFromGitHub,
): Promise<number> {
  if (argv.length === 1 && (argv[0] === "-h" || argv[0] === "--help")) {
    out(`${USAGE}\n`);
    return 0;
  }
  // `check-k` is claimed before DEFN_DIR is read, so a definition directory of
  // that exact name has to be spelled `./check-k`. The subcommand is the same
  // word in every sibling package and is worth more than that one spelling.
  if (argv[0] === "check-k") return mainCheckK(argv.slice(1), out, err, fetcher);

  const parsed = parseArgs(argv);
  if (typeof parsed === "string") {
    err(`${parsed}\n\n${USAGE}\n`);
    return 2;
  }

  try {
    const directory = parsed.definitionDirectory.replace(/[\\/]$/u, "");
    const text = await effects.readText(`${directory}/definition.kore`);
    const project = generateKleanProject(sourceFromKoreText(text), parsed);
    const errors = project.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
    if (errors.length > 0) {
      for (const diagnostic of errors) err(`${diagnostic.code}: ${diagnostic.message}\n`);
      err(`Generation stopped with ${errors.length} error${errors.length === 1 ? "" : "s"}; nothing was written.\n`);
      return 1;
    }
    const destination = await effects.writeProject(project, parsed.outputDirectory, parsed.manifest);
    out(`${destination}\n`);
    return 0;
  } catch (error) {
    if (error instanceof KleanOutputExistsError) {
      err(`${error.message}\n`);
      return 115;
    }
    err(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function parseArgs(argv: readonly string[]): ParsedArgs | string {
  let definitionDirectory: string | undefined;
  let packageName: string | undefined;
  let outputDirectory = ".";
  let libraryName: string | undefined;
  let deriveBeq = false;
  let deriveDecidableEq = false;
  let manifest = true;
  const ruleLabels: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (["-o", "--output", "-l", "--library", "-r", "--rule"].includes(argument)) {
      const value = argv[index + 1];
      if (value === undefined) return `${argument} takes a value`;
      index += 1;
      if (argument === "-o" || argument === "--output") outputDirectory = value;
      else if (argument === "-l" || argument === "--library") libraryName = value;
      else ruleLabels.push(value);
      continue;
    }
    if (argument === "--derive-beq") deriveBeq = true;
    else if (argument === "--derive-decidableeq") deriveDecidableEq = true;
    else if (argument === "--no-manifest") manifest = false;
    else if (argument === "-h" || argument === "--help") return `${argument} must be used by itself`;
    else if (argument.startsWith("-")) return `unknown option: ${argument}`;
    else if (definitionDirectory === undefined) definitionDirectory = argument;
    else if (packageName === undefined) packageName = argument;
    else return `takes exactly DEFN_DIR and PKG_NAME, got an extra argument: ${argument}`;
  }
  if (definitionDirectory === undefined || packageName === undefined) return "takes exactly DEFN_DIR and PKG_NAME";
  return {
    definitionDirectory,
    packageName,
    outputDirectory,
    manifest,
    deriveBeq,
    deriveDecidableEq,
    ...(libraryName === undefined ? {} : { libraryName }),
    ...(ruleLabels.length === 0 ? {} : { ruleLabels }),
  };
}

//////////////////////////////
// check-k                  //
//////////////////////////////

/** Render a source-drift result for both the terminal and CI logs. */
export function render(report: KleanSourcesReport): string {
  const files = report.files.map((file) => {
    const mark = file.status === "unchanged" ? "ok  " : file.status === "changed" ? "DIFF" : "GONE";
    const detail =
      file.status === "unchanged"
        ? `unchanged since ${report.recordedAt}`
        : file.status === "changed"
          ? `expected ${file.expected.slice(0, 12)}…, got ${(file.actual ?? "").slice(0, 12)}…`
          : `no such path at ${report.release}`;
    return `  ${mark}  ${file.path}\n        ${detail}\n        ${file.why}`;
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
export function exitCodeFor(verdict: KleanSourcesVerdict): number {
  return verdict === "unchanged" ? 0 : verdict === "changed" ? 1 : 3;
}

async function mainCheckK(
  args: readonly string[],
  out: (text: string) => void,
  err: (text: string) => void,
  fetcher: KleanSourceFetcher,
): Promise<number> {
  const [release, ...rest] = args;
  if (release === undefined || rest.length > 0) {
    err(`check-k takes exactly one K release tag, e.g. ${K_RELEASE}\n\n${USAGE}\n`);
    return 2;
  }

  let report: KleanSourcesReport;
  try {
    report = await checkKleanSources(release, fetcher);
  } catch (error) {
    // Failing to reach GitHub is "could not ask", which is neither a pass nor a
    // fail — reporting it as either would be a lie about upstream.
    err(`could not check ${release}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  out(render(report));
  return exitCodeFor(report.verdict);
}
