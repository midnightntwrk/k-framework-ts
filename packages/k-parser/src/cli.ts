/**
 * The `k-parser` command: three subcommands, each a pure function of its
 * arguments plus injected effects, so each is tested without spawning a process
 * and without a network or a disk.  `bin.ts` is the only file here that touches
 * `process`.
 *
 * - `k-parser parse <file>` — the `outer_syntax` **surface AST** of one file, as
 *   JSON.  Requires are not followed and nothing is converted to KAST; this is
 *   the layer `test/parser.test.ts` diffs against pyk's own encoder, made
 *   available to a shell.  It exceeds pyk, which has this dump only as a test
 *   helper (`fixtures/builtin/dump-outer.py` is that helper, vendored).
 * - `k-parser parse-outer <file>` — `parseOuter`, i.e. the whole pipeline
 *   including `require` slurping, printed as a KAST v4 document.  It is pyk's
 *   `pyk parse-outer` (`__main__.py:429-444`), except that it works on
 *   definitions that contain sentences — which pyk's cannot, because
 *   `_ast_to_kast.py:57-60` is a stub that raises.
 * - `k-parser check-k <k-release>` — the house drift check.  It fetches every
 *   declared source authority from GitHub at the requested tag and compares
 *   hashes. It works for any tag, including releases published after
 *   this package was, which is the whole point: `docs/versioning.md` records why
 *   a declared "verified through vX" range was rejected in favour of asking on
 *   demand.
 *
 * # This file reads files, and the library still does not
 *
 * The purity rule is about the **library surface**: `index.ts` exports no module
 * that imports `node:fs`, and `slurp.ts` is reached through its own
 * `@kframework-ts/k-parser/slurp` subpath.  `cli.ts` is not exported from either
 * and may therefore import `./slurp.js` directly — the same licence
 * `@kframework-ts/kompiled`'s `cli.ts` takes when it calls `loadKompiledLayout`.
 *
 * It still does not read a file *itself*.  {@link main} takes the
 * {@link FileSystem} seam `slurp.ts` defines, defaulting to the real one, so
 * `test/cli.test.ts` runs both parsing subcommands over an in-memory map and the
 * fixture tests run over the real disk where directory-relative `require`
 * resolution is half of what is being checked.
 *
 * # Output
 *
 * One line of JSON, `JSON.stringify` with no indent — pyk's
 * `json.dumps(final_definition.to_dict())` (`__main__.py:440`), and the shape
 * every `.expected.json` golden in `fixtures/` is written in.  Pipe it through
 * `jq` for a human.
 *
 * `parse-outer` wraps its term in the `{"format": "KAST", "version": 4, "term":
 * …}` envelope where pyk's `parse-outer` writes a bare `to_dict()`.  That is
 * deliberate and it is still pyk's own shape: the enveloped form is what pyk
 * writes when the output is actually *used*, in `kompilex`
 * (`__main__.py:476-480`, the temporary file it hands to `kompile
 * --outer-parsed-json`), and it is what the Java oracle
 * `fixtures/imp-outer-json/imp.json` is. A bare term is not a KAST document, and
 * nothing downstream — `@kframework-ts/kast`'s `kastTerm`, `kast-json`'s
 * `openEnvelope`, `kompile --outer-parsed-json` — accepts one.
 */

import { KAST_FORMAT, KAST_VERSION } from "@kframework-ts/kast";
import { syntaxToDict } from "./astJson.js";
import { checkKSources, type KSourceFetcher, type KSourcesReport } from "./ksources.js";
import { selectCodeBlocks } from "./markdown.js";
import { OuterParser } from "./parser.js";
import { NODE_FILE_SYSTEM, parseOuter, type FileSystem } from "./slurp.js";
import { K_RELEASE } from "./version.js";

const RAW = "https://raw.githubusercontent.com/runtimeverification/k";

export const USAGE = `k-parser <command>

  k-parser parse <file> [--md-selector S]
      Print the outer_syntax surface AST of one file as JSON. Requires are
      listed, never followed, and nothing is converted to KAST.

  k-parser parse-outer <file> [--main-module M] [--md-selector S] [-I DIR]...
      Parse a file and everything it requires into a KDefinition, printed as a
      KAST v4 document: {"format":"KAST","version":4,"term":...}.
      --main-module defaults to the file's name without its extension,
      upper-cased. -I/--include repeats.

  k-parser check-k <k-release>
      Check whether this package's transcribed sources are unchanged at a
      given K release; advisory content authorities are reported too, e.g.
      k-parser check-k ${K_RELEASE}.

A .md file is fence-selected before parsing, gated purely on the suffix; the
default selector is 'k'. Output is one line of JSON on stdout.

Exit codes: 0 success, 1 the file could not be read or parsed, 2 could not run
(usage). For check-k the same three codes mean 0 unchanged, 1 changed, 2 could
not run, plus 3 could not locate a path at that release.`;

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

//////////////////////////////
// parse / parse-outer      //
//////////////////////////////

/** The `<file>` and options both parsing subcommands are built out of. */
interface FileArgs {
  readonly file: string;
  readonly mdSelector: string;
  /** Absent means "derive it from the file name" — {@link defaultMainModule}. */
  readonly mainModule: string | undefined;
  readonly includeDirs: readonly string[];
}

/**
 * Hand-rolled argument parsing, house style: one pass, no library, and an
 * unknown option is named rather than ignored.
 *
 * `accepts` is the set of option spellings *this* subcommand takes, so
 * `k-parser parse foo.k -I lib` fails saying that `parse` has no `-I` instead of
 * silently ignoring an include directory it will never search.
 *
 * Returns the parsed arguments, or a string that is the reason it could not —
 * the caller prefixes the subcommand name and prints the usage.
 */
function parseFileArgs(args: readonly string[], accepts: ReadonlySet<string>): FileArgs | string {
  let file: string | undefined;
  let mdSelector = "k";
  let mainModule: string | undefined;
  const includeDirs: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";

    if (arg === "--md-selector" || arg === "--main-module" || arg === "-I" || arg === "--include") {
      if (!accepts.has(arg)) return `has no ${arg} option`;
      const value = args[index + 1];
      if (value === undefined) return `${arg} takes a value`;
      index += 1;
      if (arg === "--md-selector") mdSelector = value;
      else if (arg === "--main-module") mainModule = value;
      else includeDirs.push(value);
      continue;
    }

    // A bare `-` is a filename to `open`, not an option, in every tool that
    // takes one; it is not stdin here, because there is nothing to read.
    if (arg.startsWith("-") && arg !== "-") return `unknown option: ${arg}`;
    if (file !== undefined) return `takes exactly one file, got ${file} and ${arg}`;
    file = arg;
  }

  if (file === undefined) return "takes exactly one file";
  return { file, mdSelector, mainModule, includeDirs };
}

/**
 * `--main-module`'s default: `definition_file.stem.upper()`
 * (`__main__.py:431`, and identically in `kompilex` at `:449`).
 *
 * Python's `stem` strips the **last** suffix only, and strips nothing from a
 * name that is all suffix, so `imp.k` → `IMP`, `a.b.k` → `A.B`, `.k` → `.K`.
 * pyk resolves the path first, which cannot change any of that.
 */
export function defaultMainModule(file: string): string {
  const base = file.split(/[/\\]/u).at(-1) ?? file;
  const dot = base.lastIndexOf(".");
  return (dot > 0 ? base.slice(0, dot) : base).toUpperCase();
}

/**
 * Read a file the way the pipeline does: markdown selection is gated purely on
 * the `.md` suffix (`utils.py:74-75`).
 *
 * This repeats `slurp.ts`'s private `parseFile` rather than exporting it —
 * `parse` deliberately does *not* slurp, so it cannot go through
 * `slurpDefinitions`, and two lines of gate are not worth widening that module's
 * API for.
 */
function readSource(file: string, mdSelector: string, fs: FileSystem): string {
  const raw = fs.readFile(file);
  return file.endsWith(".md") ? selectCodeBlocks(raw, mdSelector) : raw;
}

/**
 * Report a failed parse or a failed read.
 *
 * `KParseError` and `RequireNotFoundError` both already say where and what, so
 * the message is printed as-is; anything else is a real I/O failure whose own
 * message (`ENOENT: … open 'foo.k'`) is the best available.
 */
function reportFailure(error: unknown, err: (text: string) => void): number {
  err(`${error instanceof Error ? error.message : String(error)}\n`);
  return 1;
}

function mainParse(
  args: readonly string[],
  out: (text: string) => void,
  err: (text: string) => void,
  fs: FileSystem,
): number {
  const parsed = parseFileArgs(args, new Set(["--md-selector"]));
  if (typeof parsed === "string") {
    err(`parse ${parsed}\n\n${USAGE}\n`);
    return 2;
  }

  try {
    const text = readSource(parsed.file, parsed.mdSelector, fs);
    // The path is passed as the source, so `Module.source` and every
    // `StringSentence.location` are populated — `outer_parser.py:373` sets those
    // only when it has one to set.
    const definition = new OuterParser(text, parsed.file).definition();
    out(`${JSON.stringify(syntaxToDict(definition))}\n`);
    return 0;
  } catch (error) {
    return reportFailure(error, err);
  }
}

function mainParseOuter(
  args: readonly string[],
  out: (text: string) => void,
  err: (text: string) => void,
  fs: FileSystem,
): number {
  const parsed = parseFileArgs(args, new Set(["--md-selector", "--main-module", "-I", "--include"]));
  if (typeof parsed === "string") {
    err(`parse-outer ${parsed}\n\n${USAGE}\n`);
    return 2;
  }

  try {
    const definition = parseOuter(parsed.file, parsed.mainModule ?? defaultMainModule(parsed.file), {
      includeDirs: parsed.includeDirs,
      mdSelector: parsed.mdSelector,
      fs,
    });
    out(`${JSON.stringify({ format: KAST_FORMAT, version: KAST_VERSION, term: definition.toDict() })}\n`);
    return 0;
  } catch (error) {
    return reportFailure(error, err);
  }
}

//////////////////////////////
// check-k                  //
//////////////////////////////

export function render(report: KSourcesReport): string {
  const lines = report.files.map((file) => {
    const mark = file.status === "unchanged" ? "ok  " : file.status === "changed" ? "DIFF" : "GONE";
    const detail =
      file.status === "unchanged"
        ? `unchanged since ${report.recordedAt}`
        : file.status === "changed"
          ? `expected ${file.expected.slice(0, 12)}…, got ${(file.actual ?? "").slice(0, 12)}…`
          : `no such path at ${report.release}`;
    const advisory = file.tier === "content" ? " (advisory content)" : "";
    return `  ${mark}  ${file.path}${advisory}\n        ${detail}`;
  });

  const summary =
    report.verdict === "unchanged"
      ? `This package's transcription is current for K ${report.release}.` +
        (report.verdicts.content === "unchanged"
          ? ""
          : ` Content-authority drift is advisory (${report.verdicts.content}); inspect it before relying on those shapes.`)
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

/**
 * The whole command.
 *
 * Both injected seams default to the real thing: `fetcher` to GitHub, `fs` to
 * `node:fs` through {@link NODE_FILE_SYSTEM}.  Passing either is what lets the
 * tests run offline and off-disk.
 */
export async function main(
  argv: readonly string[],
  out: (text: string) => void,
  err: (text: string) => void,
  fetcher: KSourceFetcher = fetchFromGitHub,
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
  if (command === "parse") return mainParse(args, out, err, fs);
  if (command === "parse-outer") return mainParseOuter(args, out, err, fs);
  if (command !== "check-k") {
    err(`unknown command: ${command}\n\n${USAGE}\n`);
    return 2;
  }

  const [release, ...rest] = args;
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
