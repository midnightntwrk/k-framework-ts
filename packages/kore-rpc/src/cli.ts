/**
 * The `kore-rpc-ts` command: three subcommands, each a pure function of its
 * arguments plus injected effects, so each is tested without spawning a
 * process, a network or a disk. `bin.ts` is the only file here that touches
 * `process`.
 *
 * - `kore-rpc-ts rpc-print <file>` — describe one recorded request or response in
 *   readable form. pyk's `pyk rpc-print` (`k/pyk/src/pyk/__main__.py:136-216`),
 *   minus the `definition_dir` argument: terms come out as KORE rather than as
 *   pretty-printed K, because this package has no KAST layer. The reasoning,
 *   and the four response shapes pyk cannot read and this can, are in
 *   `inspect.ts`'s header.
 * - `kore-rpc-ts rpc-kast <reference-request> <response>` — build the next request
 *   from a recorded `execute` response by grafting its state into a request you
 *   already have. pyk's `pyk rpc-kast` (`__main__.py:218-236`); the manual
 *   RPC-debugging loop, and the natural companion to a `BugReport` tar.
 * - `kore-rpc-ts check-k <k-release> [<haskell-backend-release>]` — the house
 *   drift check: does this transcription still hold at that K release?
 *
 * # `check-k`'s two KORE-specific twists
 *
 * Same contract as `kore`'s `check-k` (see that package and
 * `docs/versioning.md`), because this package's manifest has the same shape:
 *
 * - The sources span two repositories. If the haskell-backend release is not
 *   given, it is resolved from the k repo itself: the GitHub contents API
 *   reports the submodule commit that the requested k tag pins at
 *   `haskell-backend/src/main/native/haskell-backend`, and raw.githubusercontent
 *   serves files at a bare commit SHA just as it does at a tag.
 * - Verdicts are per tier. The exit code reflects the **format** tier only —
 *   the six `Kore/JsonRpc/*.hs` files that define the wire. `content` drift
 *   (pyk, the two servers' behaviour, the cabal file, the stale prose spec) is
 *   printed as advisory. See `version.ts`.
 *
 * # This file reads files, and the library still does not
 *
 * The purity rule is about the **library surface**: nothing `index.ts` exports
 * touches a disk. `cli.ts` is exported from neither `index.ts` nor a subpath,
 * so it may reach for `node:fs` — the same licence `@kframework-ts/k-parser`'s
 * and `@kframework-ts/kompiled`'s CLIs take. It still does not read a file
 * *itself*: {@link main} takes a {@link FileSystem} seam defaulting to the real
 * one, which is what lets `test/cli.test.ts` run both JSON subcommands over an
 * in-memory map.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { rpcKast, rpcPrint } from "./inspect.js";
import {
  checkKoreRpcSources,
  type KoreRpcSourceFetcher,
  type KoreRpcSourcesReport,
  type KoreRpcSourcesVerdict,
} from "./ksources.js";
import { K_RELEASE } from "./version.js";

const RAW = "https://raw.githubusercontent.com";
const API = "https://api.github.com";
const SUBMODULE_PATH = "haskell-backend/src/main/native/haskell-backend";

export const USAGE = `kore-rpc-ts <command>

  kore-rpc-ts rpc-print <file> [--output-file F]
      Describe one recorded kore-rpc request or response — the method, the
      halt reason, the depth, the parameters, and every term as KORE. Reads
      the JSON files a bug-report tarball is made of.

  kore-rpc-ts rpc-kast <reference-request> <response> [--output-file F]
      Turn an 'execute' response into the next request to send, by copying a
      reference request's envelope and parameters and replacing its state with
      the response's. The reference's method decides whether the result is an
      'execute' or a 'simplify'. Prints one line of JSON.

  kore-rpc-ts check-k <k-release> [<haskell-backend-release>]
      Check whether the upstream sources this package was transcribed from are
      unchanged at a given K release, e.g. kore-rpc-ts check-k ${K_RELEASE}.
      The haskell-backend tree is checked at the submodule commit that k
      release pins, unless a second release/commit is given explicitly.

Output goes to stdout unless --output-file is given.

Exit codes: 0 success, 1 the input could not be read or made sense of, 2 could
not run (usage). check-k reports the format tier (the Kore/JsonRpc wire types)
in its exit code: 0 unchanged, 1 changed, 3 could not locate, 2 could not run.
Drift in the content tier (pyk's rpc.py and its test oracle, the two servers'
own behaviour, the cabal file, the prose spec) is advisory and does not affect
the exit code.`;

//////////////////////////////
// Effects, injected        //
//////////////////////////////

/** The disk, as the two JSON subcommands need it. */
export interface FileSystem {
  /** UTF-8 contents of `path`. Throws whatever the platform throws. */
  readFile(path: string): string;
  /** Write `text` to `path` as UTF-8, replacing what was there. */
  writeFile(path: string, text: string): void;
}

/** The real one. */
export const NODE_FILE_SYSTEM: FileSystem = {
  readFile: (path) => readFileSync(path, "utf8"),
  writeFile: (path, text) => {
    writeFileSync(path, text, "utf8");
  },
};

/**
 * `fetch`, reached through `globalThis` for the same reason as Web Crypto in
 * `ksources.ts`: naming one here would collide with Bun's under the
 * development config.
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
export const fetchFromGitHub: KoreRpcSourceFetcher = async (repo, path, release) => {
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

//////////////////////////////
// rpc-print / rpc-kast     //
//////////////////////////////

/** The positional files a JSON subcommand takes, plus its one option. */
interface JsonArgs {
  readonly files: readonly string[];
  readonly outputFile: string | undefined;
}

/**
 * Hand-rolled argument parsing, house style: one pass, no library, and an
 * unknown option is named rather than ignored.
 *
 * Returns the parsed arguments, or a string that is the reason it could not —
 * the caller prefixes the subcommand name and prints the usage.
 */
function parseJsonArgs(args: readonly string[], arity: number, what: string): JsonArgs | string {
  const files: string[] = [];
  let outputFile: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--output-file" || arg === "-o") {
      const value = args[index + 1];
      if (value === undefined) return `${arg} takes a value`;
      index += 1;
      outputFile = value;
      continue;
    }
    // A bare `-` is a filename to `open`, not an option, in every tool that
    // takes one; it is not stdin here, because there is nothing to read.
    if (arg.startsWith("-") && arg !== "-") return `unknown option: ${arg}`;
    files.push(arg);
  }

  if (files.length !== arity) return `takes exactly ${what}, got ${String(files.length)}`;
  return { files, outputFile };
}

/**
 * Report a failed read, parse or render.
 *
 * Every error this can see already says what and where — `ENOENT: … open
 * 'x.json'` from the platform, `Expected params to be a JSON object` from
 * `inspect.ts`, a decoder's path-carrying message from `codec.ts` — so the
 * message is printed as it stands.
 */
function reportFailure(error: unknown, err: (text: string) => void): number {
  err(`${error instanceof Error ? error.message : String(error)}\n`);
  return 1;
}

/** `JSON.parse`, with the file's name in the failure. */
function readJson(path: string, fs: FileSystem): unknown {
  const text = fs.readFile(path);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new SyntaxError(`${path} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Send a subcommand's output to `--output-file` or to stdout, with a trailing newline either way. */
function emit(text: string, outputFile: string | undefined, out: (text: string) => void, fs: FileSystem): void {
  if (outputFile === undefined) out(`${text}\n`);
  else fs.writeFile(outputFile, `${text}\n`);
}

function mainRpcPrint(
  args: readonly string[],
  out: (text: string) => void,
  err: (text: string) => void,
  fs: FileSystem,
): number {
  const parsed = parseJsonArgs(args, 1, "one file");
  if (typeof parsed === "string") {
    err(`rpc-print ${parsed}\n\n${USAGE}\n`);
    return 2;
  }
  try {
    // `files[0]` is present: `parseJsonArgs` checked the arity above.
    emit(rpcPrint(readJson(parsed.files[0] ?? "", fs)), parsed.outputFile, out, fs);
    return 0;
  } catch (error) {
    return reportFailure(error, err);
  }
}

function mainRpcKast(
  args: readonly string[],
  out: (text: string) => void,
  err: (text: string) => void,
  fs: FileSystem,
): number {
  const parsed = parseJsonArgs(args, 2, "a reference request and a response");
  if (typeof parsed === "string") {
    err(`rpc-kast ${parsed}\n\n${USAGE}\n`);
    return 2;
  }
  try {
    const reference = readJson(parsed.files[0] ?? "", fs);
    const response = readJson(parsed.files[1] ?? "", fs);
    // `JSON.stringify`, not `emitOrdered`: this is a *request*, and requests go
    // out unordered here and in pyk — see `client.ts`'s header.
    emit(JSON.stringify(rpcKast(reference, response)), parsed.outputFile, out, fs);
    return 0;
  } catch (error) {
    return reportFailure(error, err);
  }
}

//////////////////////////////
// check-k                  //
//////////////////////////////

function summaryFor(verdict: KoreRpcSourcesVerdict, what: string): string {
  return verdict === "unchanged"
    ? `${what}: unchanged — the transcription is current.`
    : verdict === "changed"
      ? `${what}: CHANGED — diff the files above before trusting this package there.`
      : `${what}: could not locate a path — the check cannot answer; the manifest needs re-establishing.`;
}

export function render(report: KoreRpcSourcesReport): string {
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
    `format tier (what the kore-rpc wire is):\n${tierOf("format")}\n\n` +
    `content tier (the reference client and the servers' behaviour — advisory):\n${tierOf("content")}\n\n` +
    `${summaryFor(report.verdicts.format, "format")}\n` +
    `${summaryFor(report.verdicts.content, "content (advisory)")}\n`
  );
}

/** Maps the format-tier verdict to this command's contractual exit code. */
export function exitCodeFor(verdict: KoreRpcSourcesVerdict): number {
  return verdict === "unchanged" ? 0 : verdict === "changed" ? 1 : 3;
}

async function mainCheckK(
  args: readonly string[],
  out: (text: string) => void,
  err: (text: string) => void,
  fetcher: KoreRpcSourceFetcher,
  resolveSubmodule: SubmoduleResolver,
): Promise<number> {
  const [kRelease, hbRelease, ...rest] = args;
  if (kRelease === undefined || rest.length > 0) {
    err(`check-k takes a K release tag (e.g. ${K_RELEASE}) and optionally a haskell-backend release\n\n${USAGE}\n`);
    return 2;
  }

  let report: KoreRpcSourcesReport;
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
    report = await checkKoreRpcSources({ k: kRelease, haskellBackend }, fetcher);
  } catch (error) {
    // Failing to reach GitHub is "could not ask", which is neither a pass nor
    // a fail — reporting it as either would be a lie about upstream.
    err(`could not check ${kRelease}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  out(render(report));
  return exitCodeFor(report.verdicts.format);
}

//////////////////////////////
// The command              //
//////////////////////////////

/**
 * The whole command.
 *
 * Every injected seam defaults to the real thing: `fetcher` to GitHub,
 * `resolveSubmodule` to the GitHub contents API, `fs` to `node:fs`. Passing
 * them is what lets the tests run offline and off-disk.
 */
export async function main(
  argv: readonly string[],
  out: (text: string) => void,
  err: (text: string) => void,
  fetcher: KoreRpcSourceFetcher = fetchFromGitHub,
  resolveSubmodule: SubmoduleResolver = resolveSubmoduleFromGitHub,
  fs: FileSystem = NODE_FILE_SYSTEM,
): Promise<number> {
  const [command, ...args] = argv;

  if (command === undefined) {
    err(`${USAGE}\n`);
    return 2;
  }
  if (command === "--help" || command === "-h" || command === "help") {
    out(`${USAGE}\n`);
    return 0;
  }
  if (command === "rpc-print") return mainRpcPrint(args, out, err, fs);
  if (command === "rpc-kast") return mainRpcKast(args, out, err, fs);
  if (command === "check-k") return mainCheckK(args, out, err, fetcher, resolveSubmodule);

  err(`unknown command: ${command}\n\n${USAGE}\n`);
  return 2;
}
