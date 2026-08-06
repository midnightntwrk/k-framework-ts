/**
 * The `prooftrace` command — two subcommands, both of which are things a shell
 * genuinely can express.
 *
 * - `prooftrace read <header> <hints> [definition.kore]` — decode a hint stream
 *   to JSONL on stdout.  This one exists where `kfuzz`'s "run a fuzzer"
 *   subcommand deliberately does not (`docs/gap-analysis.md` S5): the inputs are
 *   three file paths, which is exactly what a command line is for, and the
 *   output is the consumer's trace file.  Without a `definition.kore` the
 *   records carry ordinals and no labels, which is still a usable diff.
 * - `prooftrace check-k <k-release> [<llvm-backend-release>]` — the house drift
 *   check.
 *
 * `read` emits records with `substitution: null`, because rendering KAST v4
 * needs a `compiled.json` and a `KDefinition`, and a CLI that took *four*
 * paths and silently produced a different record shape depending on how many
 * it got would be worse than one that says "use the library for R4".  The
 * library call is three lines and is in `README.md`.
 *
 * # This file reads files, and the library still does not
 *
 * The purity rule is about the **library surface**.  `index.ts` exports one
 * module that spawns processes (`generate.ts`, which is what `@kframework-ts/
 * ktool` is a dependency for) and nothing that reads a path; `cli.ts` is
 * exported from neither `index.ts` nor a subpath, so it may reach for
 * `node:fs`, the same licence `kore-rpc`'s and `kompiled`'s CLIs take.  It
 * still does not read a file *itself*: {@link main} takes a {@link FileSystem}
 * seam defaulting to the real one, which is what lets `test/cli.test.ts` run
 * `read` over in-memory bytes.
 */

import { readFileSync } from "node:fs";

import { parseDefinition } from "@kframework-ts/kore";

import { KoreHeader } from "./header.js";
import {
  checkProofTraceSources,
  type ProofTraceSourceFetcher,
  type ProofTraceSourcesReport,
  type ProofTraceSourcesVerdict,
} from "./ksources.js";
import { ordinalRuleIndex } from "./ordinals.js";
import { assembleProofTrace, proofTraceToJsonl } from "./records.js";
import { K_RELEASE, LLVM_BACKEND_RELEASE } from "./version.js";

const RAW = "https://raw.githubusercontent.com";
const API = "https://api.github.com";
const SUBMODULE_PATH = "llvm-backend/src/main/native/llvm-backend";

export const USAGE = `prooftrace <command>

  prooftrace read <header> <hints> [<definition.kore>]
      Decode an LLVM proof-hint stream to JSONL on stdout, one record per
      rewrite step. <header> is what 'kore-rich-header definition.kore -o'
      wrote. Given a definition.kore, each record also carries the rule's
      UNIQUE_ID, label, source and location.

      Options:
        --pre-trace       keep configuration-initialization steps
        --depth N         keep steps nested N deep inside function
                          applications (default 0; 'all' for every equation)
        --no-failures     drop rule attempts a side condition rejected

      Substitutions are omitted: rendering them as KAST v4 needs compiled.json
      as well, so R4 belongs to the library. See README.md.

  prooftrace check-k <k-release> [<llvm-backend-release>]
      Check whether the upstream sources this reader was written from are
      unchanged at a given K release, e.g. prooftrace check-k ${K_RELEASE}.
      The llvm-backend tree is checked at the submodule commit that K release
      pins, unless a second release/commit is given explicitly.

Exit codes: 0 success, 1 the input could not be read or made sense of, 2 could
not run (usage). check-k reports the format tier (the proof-trace and binary
KORE 2.0 wire) in its exit code: 0 unchanged, 1 changed, 3 could not locate.
Drift in the ordinal tier (how an ordinal names a rule) and the api tier (pyk's
wrapper and the two upstream tools) is advisory and does not affect it.`;

//////////////////////////////
// Effects, injected        //
//////////////////////////////

/** The disk, as `read` needs it. */
export interface FileSystem {
  /** Raw bytes of `path`.  Throws whatever the platform throws. */
  readBytes(path: string): Uint8Array;
  /** UTF-8 contents of `path`. */
  readText(path: string): string;
}

/** The real one. */
export const NODE_FILE_SYSTEM: FileSystem = {
  readBytes: (path) => readFileSync(path),
  readText: (path) => readFileSync(path, "utf8"),
};

/**
 * `fetch`, reached through `globalThis` for the same reason as Web Crypto in
 * `ksources.ts`.
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
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return (globalThis as unknown as { fetch: FetchLike }).fetch;
}

/** Fetches from GitHub raw.  A clean 404 is "not at this tag"; anything else throws. */
export const fetchFromGitHub: ProofTraceSourceFetcher = async (repo, path, release) => {
  const response = await theFetch()(`${RAW}/${repo}/${encodeURIComponent(release)}/${path}`);
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

//////////////////////////////
// read                     //
//////////////////////////////

interface ReadArgs {
  readonly files: readonly string[];
  readonly preTrace: boolean;
  readonly depth: number;
  readonly failures: boolean;
}

/**
 * Hand-rolled argument parsing, house style: one pass, no library, and an
 * unknown option is named rather than ignored.
 *
 * Returns the parsed arguments, or a string that is the reason it could not.
 */
function parseReadArgs(args: readonly string[]): ReadArgs | string {
  const files: string[] = [];
  let preTrace = false;
  let depth = 0;
  let failures = true;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--pre-trace") {
      preTrace = true;
      continue;
    }
    if (arg === "--no-failures") {
      failures = false;
      continue;
    }
    if (arg === "--depth") {
      const value = args[index + 1];
      if (value === undefined) return "--depth takes a value";
      index += 1;
      if (value === "all") {
        depth = Number.POSITIVE_INFINITY;
        continue;
      }
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0) return `--depth takes a non-negative integer or 'all', got ${value}`;
      depth = parsed;
      continue;
    }
    if (arg.startsWith("-") && arg !== "-") return `unknown option: ${arg}`;
    files.push(arg);
  }

  if (files.length < 2 || files.length > 3) {
    return `takes a header, a hints file and optionally a definition.kore, got ${String(files.length)} paths`;
  }
  return { files, preTrace, depth, failures };
}

function mainRead(
  args: readonly string[],
  out: (text: string) => void,
  err: (text: string) => void,
  fs: FileSystem,
): number {
  const parsed = parseReadArgs(args);
  if (typeof parsed === "string") {
    err(`read ${parsed}\n\n${USAGE}\n`);
    return 2;
  }
  const [headerPath, hintsPath, definitionPath] = parsed.files;
  try {
    const header = KoreHeader.parse(fs.readBytes(headerPath ?? ""));
    const rules =
      definitionPath === undefined
        ? []
        : ordinalRuleIndex(parseDefinition(fs.readText(definitionPath), { lazyAxioms: true }));
    const records = assembleProofTrace(fs.readBytes(hintsPath ?? ""), header, { rules }, parsed);
    out(proofTraceToJsonl(records));
    return 0;
  } catch (error) {
    // Every error this can see already names what and where — `ENOENT: … open
    // 'x.bin'` from the platform, `… (at byte 1234)` from `ProofTraceError` —
    // so the message is printed as it stands.
    err(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

//////////////////////////////
// check-k                  //
//////////////////////////////

/** Render a source-drift result for both a terminal and a CI log. */
export function render(report: ProofTraceSourcesReport): string {
  const tierOf = (tier: "format" | "ordinal" | "api"): string =>
    report.files
      .filter((file) => file.tier === tier)
      .map((file) => {
        const mark = file.status === "unchanged" ? "ok  " : file.status === "changed" ? "DIFF" : "GONE";
        const release = file.repo === "runtimeverification/k" ? report.releases.k : report.releases.llvmBackend;
        const detail =
          file.status === "unchanged"
            ? "unchanged"
            : file.status === "changed"
              ? `expected ${file.expected.slice(0, 12)}…, got ${(file.actual ?? "").slice(0, 12)}…`
              : `no such path at ${release}`;
        return `  ${mark}  ${file.repo}:${file.path}\n        ${detail}`;
      })
      .join("\n");

  return (
    `format tier (the proof-trace and binary KORE 2.0 wire):\n${tierOf("format")}\n\n` +
    `ordinal tier (how an ordinal names a rule — advisory, and the one to read):\n${tierOf("ordinal")}\n\n` +
    `api tier (pyk's wrapper and the upstream tools — advisory):\n${tierOf("api")}\n\n` +
    `${summaryFor(report.verdicts.format, "format")}\n` +
    `${summaryFor(report.verdicts.ordinal, "ordinal (advisory)")}\n` +
    `${summaryFor(report.verdicts.api, "api (advisory)")}\n`
  );
}

function summaryFor(verdict: ProofTraceSourcesVerdict, tier: string): string {
  return verdict === "unchanged"
    ? `${tier}: unchanged.`
    : verdict === "changed"
      ? `${tier}: CHANGED — diff it before trusting this package at that release.`
      : `${tier}: a path moved, so this check cannot answer. Not a verdict about compatibility.`;
}

/** Maps the format-tier verdict to this command's contractual exit code. */
export function exitCodeFor(verdict: ProofTraceSourcesVerdict): number {
  return verdict === "unchanged" ? 0 : verdict === "changed" ? 1 : 3;
}

async function mainCheckK(
  args: readonly string[],
  out: (text: string) => void,
  err: (text: string) => void,
  fetcher: ProofTraceSourceFetcher,
  resolveSubmodule: SubmoduleResolver,
): Promise<number> {
  const [kRelease, backendRelease, ...rest] = args;
  if (kRelease === undefined || rest.length > 0) {
    err(`check-k takes a K release tag (e.g. ${K_RELEASE}) and optionally an llvm-backend release\n\n${USAGE}\n`);
    return 2;
  }

  try {
    let llvmBackend = backendRelease;
    if (llvmBackend === undefined) {
      llvmBackend = await resolveSubmodule(kRelease);
      if (llvmBackend === undefined) {
        err(
          `K ${kRelease} has no submodule at ${SUBMODULE_PATH}, so the llvm-backend\n` +
            `release cannot be resolved. Pass it explicitly if you know it (this package\n` +
            `was recorded at ${LLVM_BACKEND_RELEASE}).\n`,
        );
        return 3;
      }
      out(`llvm-backend pinned by K ${kRelease}: ${llvmBackend}\n\n`);
    }
    const report = await checkProofTraceSources({ k: kRelease, llvmBackend }, fetcher);
    out(render(report));
    return exitCodeFor(report.verdicts.format);
  } catch (error) {
    err(`could not check ${kRelease}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

/** CLI core, with injected I/O, fetcher and resolver so both commands test offline. */
export function main(
  argv: readonly string[],
  out: (text: string) => void,
  err: (text: string) => void,
  deps: {
    readonly fs?: FileSystem;
    readonly fetcher?: ProofTraceSourceFetcher;
    readonly resolveSubmodule?: SubmoduleResolver;
  } = {},
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
  if (command === "read") return Promise.resolve(mainRead(args, out, err, deps.fs ?? NODE_FILE_SYSTEM));
  if (command === "check-k") {
    return mainCheckK(
      args,
      out,
      err,
      deps.fetcher ?? fetchFromGitHub,
      deps.resolveSubmodule ?? resolveSubmoduleFromGitHub,
    );
  }

  err(`unknown command: ${command}\n\n${USAGE}\n`);
  return Promise.resolve(2);
}
