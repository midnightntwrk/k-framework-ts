/**
 * The `ktool` command: Stricli routes over thin library adapters.
 *
 * The rule this file is written to, and the reason the CLI stayed minimal
 * where `pyk`'s is large: **no logic here that is not in the library**.  Every
 * route calls one exported function and renders what comes back. Stricli owns
 * route discovery, flag scanning, validation, and generated help; the pure
 * legacy parser exports remain temporarily available to downstream tests.
 *
 * - `ktool kompile <main-file>` — {@link kompile}, i.e. `kompile` itself.
 *   Prints the output directory.
 * - `ktool run <kompiled-dir> <file>` — {@link llvmInterpret} when the
 *   definition carries an `interpreter` and the input is a KORE configuration,
 *   `krun` otherwise; rendered through {@link korePrint}.
 * - `ktool parse <kompiled-dir> <text>` — {@link KPrint.parseToken}, i.e. the
 *   `kast` binary at a sort.
 * - `ktool claims <spec.k>` — {@link ClaimLoader} over {@link KproveModuleParser},
 *   printing the resolved labels.
 * - `ktool check-k <k-release>` — the house drift check.
 * - `ktool lr1 bison <grammar.y>` — classify an existing Bison grammar.
 * - `ktool lr1 k <definition.k>` — capture K's PGM grammar and classify it.
 *
 * # Streams and exit codes
 *
 * `main` takes its two sinks, so every subcommand is drivable as a function.
 * The one deliberate exception is `kompile`, which runs with `toolMode: true`:
 * a compiler's diagnostics belong on the terminal as they happen, so `kompile`'s
 * own stdout and stderr are mirrored onto this process's directly and the
 * failure line printed through `err` says only the status.  Nothing else here
 * writes outside the sinks.
 *
 * Exit codes, house contract: 0 success, 1 the operation failed (K exited
 * non-zero, a file could not be read, a label did not resolve), 2 could not run
 * (usage), plus 3 for `check-k`'s "could not locate a path".
 *
 * # This file reads files, and the library still does not
 *
 * The purity rule is about the library *surface*: `index.ts` exports no module
 * that reads a path the caller did not name.  `cli.ts` is exported from
 * nowhere, so it may `readFile` directly — the same licence
 * `@kframework-ts/kompiled`'s and `@kframework-ts/k-parser`'s CLIs take.
 */

import { analyzeBisonLr1File } from "@kframework-ts/bison";
import { claimDependencies, kastTermToDict, ksort, ktoken, sentenceLabel, type KInner } from "@kframework-ts/kast";
import { koreText, KoreParser, type Pattern } from "@kframework-ts/kore";
import {
  buildApplication,
  buildCommand,
  buildRouteMap,
  run as runStricli,
  type CommandContext,
  type StricliProcess,
} from "@stricli/core";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { ClaimIndexError, staticOrder } from "./claim-index.js";
import { ClaimLoader, type LoadClaimsOptions } from "./claim-loader.js";
import { getKDistribution } from "./distribution.js";
import { checkKGrammarLr1 } from "./generated-bison.js";
import { llvmInterpret } from "./interpreter.js";
import { bisonLr1Json, kGrammarLr1Json, KtoolLr1JsonSchema } from "./lr1-json.js";
import {
  buildKompileArgv,
  kompile,
  KOMPILE_BACKENDS,
  LLVM_KOMPILE_TYPES,
  TYPE_INFERENCE_MODES,
  WARNINGS,
  type KompileBackend,
  type KompileCallOptions,
  type KompileSpec,
  type LLVMKompileType,
  type TypeInferenceMode,
  type Warnings,
} from "./kompile.js";
import { korePrint } from "./kore-print.js";
import { KPrint } from "./kprint.js";
import { KRun, runKrun } from "./krun.js";
import { KproveModuleParser } from "./parse-modules.js";
import {
  checkKtoolSources,
  type KtoolGitlinkAwareFetcher,
  type KtoolSourceFetcher,
  type KtoolSourcesReport,
  type KtoolSourcesVerdict,
} from "./ksources.js";
import { formatCommand, ProcessError } from "./proc.js";
import { K_RELEASE } from "./version.js";

const RAW = "https://raw.githubusercontent.com";

/** How `ktool run` reads its input file. */
export const RUN_INPUTS = ["kore", "program"] as const;
export type RunInput = (typeof RUN_INPUTS)[number];

/**
 * `ktool run --output`: `kore-print`'s `PrintOutput` **minus `latex`**.
 *
 * The library's enum carries `latex` because pyk's `PrintOutput` does, and
 * `kore-print`'s own option table rejects it — upstream's mismatch, kept there
 * on purpose.  A CLI that accepted it would spend a process to earn a usage
 * error, so it is rejected here instead.
 */
export const RUN_OUTPUTS = ["pretty", "program", "kast", "binary", "json", "kore", "none"] as const;
export type RunOutput = (typeof RUN_OUTPUTS)[number];

//////////////////////////////
// The fetcher              //
//////////////////////////////

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
  json(): Promise<unknown>;
}

type FetchLike = (url: string) => Promise<ResponseLike>;

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/** Fetches from GitHub raw.  A 404 is "not at this tag"; anything else throws. */
const fetchFromGitHubRaw: KtoolSourceFetcher = async (repo, path, release) => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const { fetch } = globalThis as unknown as { fetch: FetchLike };
  const response = await fetch(`${RAW}/${repo}/${encodeURIComponent(release)}/${path}`);
  // Only a clean 404 means "not at this tag". Anything else is a failure to
  // ask, which must not be reported as a fact about K.
  if (!response.ok && response.status !== 404) {
    throw new Error(`GET ${repo}/${path} at ${release}: HTTP ${response.status} ${response.statusText}`);
  }
  return response.status === 404 ? undefined : new Uint8Array(await response.arrayBuffer());
};

/** The production fetcher also resolves immutable backend commits from K's gitlinks. */
export const fetchFromGitHub: KtoolGitlinkAwareFetcher = Object.assign(fetchFromGitHubRaw, {
  gitlink: async (repo: string, path: string, release: string): Promise<string | undefined> => {
    // GitHub's raw endpoint cannot traverse a gitlink. Resolve it from K's tree,
    // then fetch the backend file at that immutable submodule commit.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const { fetch } = globalThis as unknown as { fetch: FetchLike };
    const response = await fetch(
      `https://api.github.com/repos/${repo}/git/trees/${encodeURIComponent(release)}?recursive=1`,
    );
    if (!response.ok && response.status !== 404)
      throw new Error(`GET git tree ${repo}@${release}: HTTP ${response.status} ${response.statusText}`);
    if (response.status === 404) return undefined;
    const body = await response.json();
    if (typeof body !== "object" || body === null || !("tree" in body) || !isUnknownArray(body.tree))
      throw new Error(`Malformed git tree response for ${repo}@${release}`);
    const entry = body.tree.find(
      (item): item is { path: string; type: string; sha: string } =>
        typeof item === "object" &&
        item !== null &&
        "path" in item &&
        "type" in item &&
        "sha" in item &&
        item.path === path &&
        item.type === "commit" &&
        typeof item.sha === "string",
    );
    return entry?.sha;
  },
});

//////////////////////////////
// Shared parsing helpers   //
//////////////////////////////

/**
 * `value` as one of `values`, or `undefined`.
 *
 * Narrowing rather than returning `T | string`: a union of a string literal
 * type with `string` collapses to `string`, so "the value, or the reason it is
 * not" cannot be one return type here.  {@link badValue} is the other half.
 */
function oneOf<T extends string>(value: string, values: readonly T[]): T | undefined {
  // `find`, not `includes` plus an assertion: the element that compares equal
  // already has the type, so nothing has to be asserted into it.
  return values.find((candidate) => candidate === value);
}

/** The reason {@link oneOf} said no. */
function badValue(flag: string, values: readonly string[]): string {
  return `${flag} must be one of: ${values.join(" ")}`;
}

/** A non-negative integer, or a reason. */
function nonNegativeInt(flag: string, value: string): number | string {
  return /^[0-9]+$/u.test(value) ? Number(value) : `${flag} takes a non-negative integer, got ${value}`;
}

/**
 * `--labels a,b --labels c` → `['a', 'b', 'c']`.
 *
 * Repeatable *and* comma-separated, because `--claims` is comma-joined in
 * `kprove`'s own argv (`parse-modules.ts`) and a user who has seen that spelling
 * should not have to learn a second one.
 */
function pushCommaSeparated(into: string[], value: string): void {
  for (const part of value.split(",")) if (part !== "") into.push(part);
}

//////////////////////////////
// kompile                  //
//////////////////////////////

/** What `ktool kompile` turns its flags into — exactly the library's two arguments. */
export interface KompileInvocation {
  readonly spec: KompileSpec;
  readonly options: KompileCallOptions;
  /** `--dry-run`: print the argv, spawn nothing. */
  readonly dryRun: boolean;
}

/** The flags only `--backend llvm` accepts. */
const LLVM_ONLY_FLAGS = [
  "-O0",
  "-O1",
  "-O2",
  "-O3",
  "--llvm-kompile-type",
  "--llvm-kompile-output",
  "-ccopt",
  "--no-llvm-kompile",
  "--enable-search",
  "--enable-llvm-debug",
  "--heuristic",
  "--iterated-threshold",
] as const;

/** The flags only `--backend haskell` accepts. */
const HASKELL_ONLY_FLAGS = ["--concrete-rules", "--no-haskell-binary"] as const;

/**
 * Every `ktool kompile` flag that consumes the argument after it.
 *
 * One set, checked before anything else, so "takes a value" is said once rather
 * than at twenty branches.
 */
const VALUE_FLAGS: ReadonlySet<string> = new Set([
  "--backend",
  "--main-module",
  "--syntax-module",
  "-I",
  "--include",
  "--md-selector",
  "--hook-namespaces",
  "--post-process",
  "--top-cell",
  "--llvm-kompile-type",
  "--llvm-kompile-output",
  "-ccopt",
  "--heuristic",
  "--iterated-threshold",
  "--concrete-rules",
  "-o",
  "--output-definition",
  "--temp-dir",
  "--type-inference-mode",
  "--warnings",
  "-Wno",
]);

/**
 * `ktool kompile`'s flags → a {@link KompileSpec} and a
 * {@link KompileCallOptions}.  Pure: no filesystem, no process.
 *
 * A backend-specific flag used against another backend is a *named* error
 * rather than a silently dropped option — the union in `kompile.ts` makes that
 * a compile error for a library caller, and this is the runtime half of the same
 * guarantee.
 *
 * @returns the invocation, or a one-line reason it could not be built.  The
 *   caller prefixes `kompile ` and prints the usage.
 */
export function parseKompileArgs(args: readonly string[]): KompileInvocation | string {
  let mainFile: string | undefined;
  let backend: KompileBackend = "llvm";
  const seen = new Set<string>();

  // KompileArgs
  let mainModule: string | undefined;
  let syntaxModule: string | undefined;
  const includeDirs: string[] = [];
  let mdSelector: string | undefined;
  const hookNamespaces: string[] = [];
  let emitJson = true;
  let genBisonParser = false;
  let genGlrBisonParser = false;
  let bisonParserLibrary = false;
  let bisonLists = false;
  let postProcess: string | undefined;
  let readOnly = false;
  let coverage = false;
  let outerParsedJson = false;
  let topCell: string | undefined;

  // LLVMKompileOptions
  let llvmKompileType: LLVMKompileType | undefined;
  let llvmKompileOutput: string | undefined;
  let optLevel: number | undefined;
  const ccopts: string[] = [];
  let noLlvmKompile = false;
  let enableSearch = false;
  let enableLlvmDebug = false;
  let heuristic: string | undefined;
  let iteratedThreshold: string | undefined;

  // HaskellKompileOptions
  const concreteRules: string[] = [];
  let haskellBinary = true;

  // KompileCallOptions
  let outputDir: string | undefined;
  let tempDir: string | undefined;
  let typeInferenceMode: TypeInferenceMode | undefined;
  let warnings: Warnings | undefined;
  let warningsToErrors = false;
  let noExcWrap = false;
  let debug = false;
  let verbose = false;
  const ignoreWarnings: string[] = [];
  let dryRun = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    seen.add(arg);

    /** The value that follows `arg`, consuming it, or `undefined` at the end. */
    const value = (): string | undefined => {
      const next = args[index + 1];
      if (next !== undefined) index += 1;
      return next;
    };

    // Every flag that takes a value, in one branch, so "takes a value" is said
    // once rather than thirty times.
    if (VALUE_FLAGS.has(arg)) {
      const raw = value();
      if (raw === undefined) return `${arg} takes a value`;

      switch (arg) {
        case "--backend": {
          const parsed = oneOf(raw, KOMPILE_BACKENDS);
          if (parsed === undefined) return badValue(arg, KOMPILE_BACKENDS);
          // `kore` is a name `--backend` accepts and `KompileSpec` cannot
          // carry: pyk's `from_dict` raises on it too (`kompile.py:265-266`).
          if (parsed === "kore") return "--backend kore has no spec form; pyk's from_dict rejects it too";
          backend = parsed;
          break;
        }
        case "--main-module":
          mainModule = raw;
          break;
        case "--syntax-module":
          syntaxModule = raw;
          break;
        case "-I":
        case "--include":
          includeDirs.push(raw);
          break;
        case "--md-selector":
          mdSelector = raw;
          break;
        case "--hook-namespaces":
          hookNamespaces.push(raw);
          break;
        case "--post-process":
          postProcess = raw;
          break;
        case "--top-cell":
          topCell = raw;
          break;
        case "--llvm-kompile-type": {
          const parsed = oneOf(raw, LLVM_KOMPILE_TYPES);
          if (parsed === undefined) return badValue(arg, LLVM_KOMPILE_TYPES);
          llvmKompileType = parsed;
          break;
        }
        case "--llvm-kompile-output":
          llvmKompileOutput = raw;
          break;
        case "-ccopt":
          ccopts.push(raw);
          break;
        case "--heuristic":
          heuristic = raw;
          break;
        case "--iterated-threshold":
          iteratedThreshold = raw;
          break;
        case "--concrete-rules":
          pushCommaSeparated(concreteRules, raw);
          break;
        case "-o":
        case "--output-definition":
          outputDir = raw;
          break;
        case "--temp-dir":
          tempDir = raw;
          break;
        case "--type-inference-mode": {
          const parsed = oneOf(raw, TYPE_INFERENCE_MODES);
          if (parsed === undefined) return badValue(arg, TYPE_INFERENCE_MODES);
          typeInferenceMode = parsed;
          break;
        }
        case "--warnings": {
          const parsed = oneOf(raw, WARNINGS);
          if (parsed === undefined) return badValue(arg, WARNINGS);
          warnings = parsed;
          break;
        }
        default:
          pushCommaSeparated(ignoreWarnings, raw); // -Wno
          break;
      }
      continue;
    }

    const optMatch = /^-O([0-3])$/u.exec(arg);
    if (optMatch !== null) {
      optLevel = Number(optMatch[1]);
      continue;
    }

    switch (arg) {
      case "--no-emit-json":
        emitJson = false;
        continue;
      case "--gen-bison-parser":
        genBisonParser = true;
        continue;
      case "--gen-glr-bison-parser":
        genGlrBisonParser = true;
        continue;
      case "--bison-parser-library":
        bisonParserLibrary = true;
        continue;
      case "--bison-lists":
        bisonLists = true;
        continue;
      case "--read-only-kompiled-directory":
        readOnly = true;
        continue;
      case "--coverage":
        coverage = true;
        continue;
      case "--outer-parsed-json":
        outerParsedJson = true;
        continue;
      case "--no-llvm-kompile":
        noLlvmKompile = true;
        continue;
      case "--enable-search":
        enableSearch = true;
        continue;
      case "--enable-llvm-debug":
        enableLlvmDebug = true;
        continue;
      case "--no-haskell-binary":
        haskellBinary = false;
        continue;
      case "--warnings-to-errors":
        warningsToErrors = true;
        continue;
      case "--no-exc-wrap":
        noExcWrap = true;
        continue;
      case "--debug":
        debug = true;
        continue;
      case "--verbose":
        verbose = true;
        continue;
      case "--dry-run":
        dryRun = true;
        continue;
      default:
        break;
    }

    if (arg.startsWith("-")) return `unknown option: ${arg}`;
    if (mainFile !== undefined) return `takes exactly one main file, got ${mainFile} and ${arg}`;
    mainFile = arg;
  }

  if (mainFile === undefined) return "takes exactly one main file";

  for (const flag of LLVM_ONLY_FLAGS) {
    if (seen.has(flag) && backend !== "llvm") return `${flag} is an llvm-backend option, but --backend is ${backend}`;
  }
  for (const flag of HASKELL_ONLY_FLAGS) {
    if (seen.has(flag) && backend !== "haskell") {
      return `${flag} is a haskell-backend option, but --backend is ${backend}`;
    }
  }

  const common = {
    mainFile,
    ...(mainModule === undefined ? {} : { mainModule }),
    ...(syntaxModule === undefined ? {} : { syntaxModule }),
    ...(includeDirs.length === 0 ? {} : { includeDirs }),
    ...(mdSelector === undefined ? {} : { mdSelector }),
    ...(hookNamespaces.length === 0 ? {} : { hookNamespaces }),
    emitJson,
    ...(genBisonParser ? { genBisonParser } : {}),
    ...(genGlrBisonParser ? { genGlrBisonParser } : {}),
    ...(bisonParserLibrary ? { bisonParserLibrary } : {}),
    ...(bisonLists ? { bisonLists } : {}),
    ...(postProcess === undefined ? {} : { postProcess }),
    ...(readOnly ? { readOnly } : {}),
    ...(coverage ? { coverage } : {}),
    ...(outerParsedJson ? { outerParsedJson } : {}),
    ...(topCell === undefined ? {} : { topCell }),
  };

  const spec: KompileSpec =
    backend === "llvm"
      ? {
          backend: "llvm",
          ...common,
          ...(llvmKompileType === undefined ? {} : { llvmKompileType }),
          ...(llvmKompileOutput === undefined ? {} : { llvmKompileOutput }),
          ...(optLevel === undefined ? {} : { optLevel }),
          ...(ccopts.length === 0 ? {} : { ccopts }),
          ...(noLlvmKompile ? { noLlvmKompile } : {}),
          ...(enableSearch ? { enableSearch } : {}),
          ...(enableLlvmDebug ? { enableLlvmDebug } : {}),
          ...(heuristic === undefined ? {} : { heuristic }),
          ...(iteratedThreshold === undefined ? {} : { iteratedThreshold }),
        }
      : backend === "haskell"
        ? {
            backend: "haskell",
            ...common,
            ...(concreteRules.length === 0 ? {} : { concreteRules }),
            haskellBinary,
          }
        : { backend: "maude", ...common };

  const options: KompileCallOptions = {
    ...(outputDir === undefined ? {} : { outputDir }),
    ...(tempDir === undefined ? {} : { tempDir }),
    ...(typeInferenceMode === undefined ? {} : { typeInferenceMode }),
    ...(warnings === undefined ? {} : { warnings }),
    ...(warningsToErrors ? { warningsToErrors } : {}),
    ...(noExcWrap ? { noExcWrap } : {}),
    ...(debug ? { debug } : {}),
    ...(verbose ? { verbose } : {}),
    ...(ignoreWarnings.length === 0 ? {} : { ignoreWarnings }),
  };

  return { spec, options, dryRun };
}

async function mainKompile(
  args: readonly string[],
  out: (text: string) => void,
  err: (text: string) => void,
): Promise<number> {
  const parsed = parseKompileArgs(args);
  if (typeof parsed === "string") {
    err(`kompile ${parsed}\n`);
    return 2;
  }

  if (parsed.dryRun) {
    out(`${formatCommand(buildKompileArgv(parsed.spec, parsed.options))}\n`);
    return 0;
  }

  try {
    // `toolMode` mirrors kompile's own two streams onto this process's, which
    // is what a compiler driver owes its user; see the module header.
    const dir = await kompile(parsed.spec, {
      ...parsed.options,
      toolMode: true,
    });
    out(`${dir}\n`);
    return 0;
  } catch (error) {
    // The child's stderr has already been mirrored, so repeating it inside the
    // ProcessError message would print it twice.
    if (error instanceof ProcessError) {
      err(`kompile failed with status ${error.returncode}\n`);
      return 1;
    }
    err(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

//////////////////////////////
// run                      //
//////////////////////////////

/** What `ktool run` turns its flags into. */
export interface RunInvocation {
  readonly definitionDir: string;
  readonly file: string;
  readonly input: RunInput;
  readonly depth: number | undefined;
  readonly output: RunOutput;
  /** `--krun`: take the `krun` route even when the definition has an interpreter. */
  readonly forceKrun: boolean;
  readonly parser: string | undefined;
}

/**
 * `ktool run`'s flags.  Pure.
 *
 * `--input` defaults on the file's suffix, which is the only signal available
 * without opening it: a `.kore` file is a configuration, anything else is a
 * program that only `krun` can parse.
 */
export function parseRunArgs(args: readonly string[]): RunInvocation | string {
  const positional: string[] = [];
  let input: RunInput | undefined;
  let depth: number | undefined;
  let output: RunOutput = "pretty";
  let forceKrun = false;
  let parser: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";

    if (arg === "--input" || arg === "--depth" || arg === "--output" || arg === "--parser") {
      const raw = args[index + 1];
      if (raw === undefined) return `${arg} takes a value`;
      index += 1;

      if (arg === "--input") {
        const parsedInput = oneOf(raw, RUN_INPUTS);
        if (parsedInput === undefined) return badValue(arg, RUN_INPUTS);
        input = parsedInput;
      } else if (arg === "--depth") {
        const parsedDepth = nonNegativeInt(arg, raw);
        if (typeof parsedDepth !== "number") return parsedDepth;
        depth = parsedDepth;
      } else if (arg === "--output") {
        const parsedOutput = oneOf(raw, RUN_OUTPUTS);
        if (parsedOutput === undefined) return badValue(arg, RUN_OUTPUTS);
        output = parsedOutput;
      } else {
        parser = raw;
      }
      continue;
    }

    if (arg === "--krun") {
      forceKrun = true;
      continue;
    }
    if (arg.startsWith("-")) return `unknown option: ${arg}`;
    positional.push(arg);
  }

  const [definitionDir, file, ...rest] = positional;
  if (definitionDir === undefined || file === undefined || rest.length > 0) {
    return "takes exactly a kompiled directory and a file";
  }

  const resolved = input ?? (file.endsWith(".kore") ? "kore" : "program");
  if (parser !== undefined && resolved === "kore") {
    return "--parser applies to program input only; a KORE configuration is not parsed by krun";
  }

  return {
    definitionDir,
    file,
    input: resolved,
    depth,
    output,
    forceKrun,
    parser,
  };
}

/**
 * Which route a KORE input takes.  Pure, so the decision is testable without a
 * definition directory: an `interpreter` beats `krun` unless `--krun` says
 * otherwise, and the two produce the same pattern because
 * {@link KRun.runPattern} forces `--term`, which is what
 * {@link llvmInterpret} does by construction.
 */
export function runRoute(hasInterpreter: boolean, forceKrun: boolean): "interpreter" | "krun" {
  return hasInterpreter && !forceKrun ? "interpreter" : "krun";
}

/**
 * `KRun.run`'s rendering table (`krun.py:243-259`), applied to a pattern this
 * command already holds.
 *
 * `kore` and `json` never leave the process; everything else is `kore-print`.
 */
async function renderPattern(kprint: KPrint, pattern: Pattern, output: RunOutput): Promise<string | undefined> {
  if (output === "none") return undefined;
  if (output === "kore") return koreText(pattern);
  if (output === "json") return JSON.stringify(kastTermToDict(await kprint.koreToKast(pattern)));
  return korePrint(pattern, { definitionDir: kprint.definitionDir, output });
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function mainRun(
  args: readonly string[],
  out: (text: string) => void,
  err: (text: string) => void,
): Promise<number> {
  const parsed = parseRunArgs(args);
  if (typeof parsed === "string") {
    err(`run ${parsed}\n`);
    return 2;
  }

  try {
    const kprint = await KPrint.load(parsed.definitionDir);

    let final: Pattern;
    if (parsed.input === "program") {
      // A program has no KORE form until K parses it, so this route is krun's
      // alone.  `--output kore` from the child, rendered here, keeps the
      // rendering table identical to the configuration route's.
      const result = await runKrun({
        inputFile: parsed.file,
        definitionDir: parsed.definitionDir,
        output: "kore",
        ...(parsed.parser === undefined ? {} : { parser: parsed.parser }),
        ...(parsed.depth === undefined ? {} : { depth: parsed.depth }),
        check: false,
      });
      if (result.returncode !== 0) {
        err(result.stderr === "" ? `krun exited with status ${result.returncode}\n` : `${result.stderr.trimEnd()}\n`);
        return 1;
      }
      final = new KoreParser(result.stdout).pattern();
    } else {
      const pattern = new KoreParser(await readFile(parsed.file, "utf8")).pattern();
      const depth = parsed.depth === undefined ? {} : { depth: parsed.depth };
      if (runRoute(await isFile(join(parsed.definitionDir, "interpreter")), parsed.forceKrun) === "interpreter") {
        final = await llvmInterpret(parsed.definitionDir, pattern, depth);
      } else {
        const krun = new KRun(kprint);
        final = await krun.runPattern(pattern, { ...depth, check: true });
      }
    }

    const rendered = await renderPattern(kprint, final, parsed.output);
    if (rendered !== undefined) out(rendered.endsWith("\n") ? rendered : `${rendered}\n`);
    return 0;
  } catch (error) {
    err(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

//////////////////////////////
// parse                    //
//////////////////////////////

/** `ktool parse`'s renderings of the term `kast` handed back. */
export const PARSE_OUTPUTS = ["json", "pretty", "kore"] as const;
export type ParseOutput = (typeof PARSE_OUTPUTS)[number];

/** What `ktool parse` turns its flags into. */
export interface ParseInvocation {
  readonly definitionDir: string;
  /** The text to parse, or — with {@link fromFile} — the path holding it. */
  readonly text: string;
  readonly fromFile: boolean;
  readonly sort: string;
  readonly asRule: boolean;
  readonly output: ParseOutput;
}

/** `ktool parse`'s flags.  Pure. */
export function parseParseArgs(args: readonly string[]): ParseInvocation | string {
  const positional: string[] = [];
  let sort: string | undefined;
  let fromFile = false;
  let asRule = false;
  let output: ParseOutput = "json";

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";

    if (arg === "--sort" || arg === "--output") {
      const raw = args[index + 1];
      if (raw === undefined) return `${arg} takes a value`;
      index += 1;
      if (arg === "--sort") {
        sort = raw;
      } else {
        const parsedOutput = oneOf(raw, PARSE_OUTPUTS);
        if (parsedOutput === undefined) return badValue(arg, PARSE_OUTPUTS);
        output = parsedOutput;
      }
      continue;
    }

    if (arg === "--file") {
      fromFile = true;
      continue;
    }
    if (arg === "--as-rule") {
      asRule = true;
      continue;
    }
    // A `-` is not an option here: rule text starts with one often enough
    // (`-1`), and there is no stdin mode to claim the spelling.
    if (arg.startsWith("--")) return `unknown option: ${arg}`;
    positional.push(arg);
  }

  const [definitionDir, text, ...rest] = positional;
  if (definitionDir === undefined || text === undefined || rest.length > 0) {
    return "takes exactly a kompiled directory and one text (or, with --file, one path)";
  }
  // `parseToken` takes a `KToken`, which has no default sort — and neither does
  // `kast --sort`, whose default is whatever the definition declares as its
  // start symbol.  Guessing `K` here would be a lie that only shows up as a
  // parse error from the child.
  if (sort === undefined) return "requires --sort";

  return { definitionDir, text, fromFile, sort, asRule, output };
}

async function mainParse(
  args: readonly string[],
  out: (text: string) => void,
  err: (text: string) => void,
): Promise<number> {
  const parsed = parseParseArgs(args);
  if (typeof parsed === "string") {
    err(`parse ${parsed}\n`);
    return 2;
  }

  try {
    const kprint = await KPrint.load(parsed.definitionDir);
    const text = parsed.fromFile ? await readFile(parsed.text, "utf8") : parsed.text;
    const term: KInner = await kprint.parseToken(ktoken(text, ksort(parsed.sort)), { asRule: parsed.asRule });

    const rendered =
      parsed.output === "json"
        ? JSON.stringify(kastTermToDict(term))
        : parsed.output === "pretty"
          ? kprint.prettyPrint(term)
          : koreText(await kprint.kastToKore(term));
    out(rendered.endsWith("\n") ? rendered : `${rendered}\n`);
    return 0;
  } catch (error) {
    err(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

//////////////////////////////
// claims                   //
//////////////////////////////

/** What `ktool claims` turns its flags into. */
export interface ClaimsInvocation {
  readonly specFile: string;
  readonly definitionDir: string;
  readonly options: LoadClaimsOptions;
  /** `--ordered`: topological order, dependencies first. */
  readonly ordered: boolean;
  /** `--builtin-dir` was not given, so ask `PATH` for it. */
  readonly findBuiltinDir: boolean;
  readonly verbose: boolean;
}

/** `ktool claims`'s flags.  Pure — the `PATH` lookup it may imply is a flag, not a side effect. */
export function parseClaimsArgs(args: readonly string[]): ClaimsInvocation | string {
  const positional: string[] = [];
  let definitionDir: string | undefined;
  let specModuleName: string | undefined;
  let mdSelector: string | undefined;
  let typeInferenceMode: TypeInferenceMode | undefined;
  let builtinDir: string | undefined;
  const includeDirs: string[] = [];
  const claimLabels: string[] = [];
  const excludeClaimLabels: string[] = [];
  let includeDependencies = true;
  let ordered = false;
  let verbose = false;

  const valued = new Set([
    "--definition",
    "--spec-module",
    "--md-selector",
    "--type-inference-mode",
    "--builtin-dir",
    "-I",
    "--include",
    "--labels",
    "--exclude",
  ]);

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";

    if (valued.has(arg)) {
      const raw = args[index + 1];
      if (raw === undefined) return `${arg} takes a value`;
      index += 1;

      switch (arg) {
        case "--definition":
          definitionDir = raw;
          break;
        case "--spec-module":
          specModuleName = raw;
          break;
        case "--md-selector":
          mdSelector = raw;
          break;
        case "--builtin-dir":
          builtinDir = raw;
          break;
        case "-I":
        case "--include":
          includeDirs.push(raw);
          break;
        case "--labels":
          pushCommaSeparated(claimLabels, raw);
          break;
        case "--exclude":
          pushCommaSeparated(excludeClaimLabels, raw);
          break;
        default: {
          // The only remaining valued flag is `--type-inference-mode`.
          const parsed = oneOf(raw, TYPE_INFERENCE_MODES);
          if (parsed === undefined) return badValue(arg, TYPE_INFERENCE_MODES);
          typeInferenceMode = parsed;
          break;
        }
      }
      continue;
    }

    if (arg === "--no-depends") {
      includeDependencies = false;
      continue;
    }
    if (arg === "--ordered") {
      ordered = true;
      continue;
    }
    if (arg === "--verbose") {
      verbose = true;
      continue;
    }
    if (arg.startsWith("-")) return `unknown option: ${arg}`;
    positional.push(arg);
  }

  const [specFile, ...rest] = positional;
  if (specFile === undefined || rest.length > 0) return "takes exactly one spec file";
  // `KproveModuleParser` has no default for this and should not invent one: the
  // spec is parsed *against* a definition, and the wrong one parses differently.
  if (definitionDir === undefined) return "requires --definition <kompiled-dir>";

  const options: LoadClaimsOptions = {
    ...(specModuleName === undefined ? {} : { specModuleName }),
    ...(includeDirs.length === 0 ? {} : { includeDirs }),
    ...(mdSelector === undefined ? {} : { mdSelector }),
    ...(typeInferenceMode === undefined ? {} : { typeInferenceMode }),
    ...(builtinDir === undefined ? {} : { builtinDir }),
    ...(claimLabels.length === 0 ? {} : { claimLabels }),
    ...(excludeClaimLabels.length === 0 ? {} : { excludeClaimLabels }),
    includeDependencies,
  };

  return {
    specFile,
    definitionDir,
    options,
    ordered,
    findBuiltinDir: builtinDir === undefined,
    verbose,
  };
}

async function mainClaims(
  args: readonly string[],
  out: (text: string) => void,
  err: (text: string) => void,
): Promise<number> {
  const parsed = parseClaimsArgs(args);
  if (typeof parsed === "string") {
    err(`claims ${parsed}\n`);
    return 2;
  }

  try {
    // pyk reaches `K_DISTRIBUTION.builtin_dir` here (`claim_loader.py:97`).  The
    // library takes it as a parameter to stay pure, so the lookup is the CLI's
    // job — and its absence changes the digest, so it is worth doing.
    const builtinDir = parsed.findBuiltinDir ? (await getKDistribution())?.builtinDir : undefined;

    const logger = (message: string): void => {
      err(`${message}\n`);
    };
    const loader = new ClaimLoader(
      new KproveModuleParser({ definitionDir: parsed.definitionDir }),
      parsed.verbose ? { logger } : {},
    );
    const claims = await loader.loadClaims(parsed.specFile, {
      ...parsed.options,
      ...(builtinDir === undefined ? {} : { builtinDir }),
    });

    let labels = claims.map((claim) => sentenceLabel(claim));
    if (parsed.ordered) {
      // `ClaimIndex.sortTopologically` restricted to the selection, built from
      // the same two `kast` accessors the index uses.  Going through a second
      // `ClaimIndex` instead would re-validate, and a `--no-depends` or
      // `--exclude` selection is legitimately missing its dependencies.
      //
      // One consequence, because `staticOrder` breaks ties on insertion order:
      // the graph is built in *selection* order here, where the index builds it
      // in index order (`claim-index.ts:399-410`).  Both are valid topological
      // orders and they coincide whenever the whole spec is selected — which is
      // the default — but a `--labels` subset can come back permuted against
      // what `ClaimIndex.labels({ordered: true})` would return.
      const selected = new Set(labels);
      const graph = new Map(
        claims.map((claim) => [sentenceLabel(claim), claimDependencies(claim).filter((dep) => selected.has(dep))]),
      );
      labels = staticOrder(graph);
    }

    for (const label of labels) out(`${label}\n`);
    return 0;
  } catch (error) {
    // A ClaimIndexError already says which label and why; anything else is an
    // I/O or a child failure whose own message is the best available.
    err(`${error instanceof ClaimIndexError || error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

//////////////////////////////
// check-k                  //
//////////////////////////////

function summaryFor(verdict: KtoolSourcesVerdict, what: string): string {
  return verdict === "unchanged"
    ? `${what}: unchanged — the transcription is current.`
    : verdict === "changed"
      ? `${what}: CHANGED — diff the files above before trusting this package there.`
      : `${what}: could not locate a path — the check cannot answer; the manifest needs re-establishing.`;
}

export function render(report: KtoolSourcesReport): string {
  const tierOf = (tier: "format" | "content"): string =>
    report.files
      .filter((file) => file.tier === tier)
      .map((file) => {
        const mark = file.status === "unchanged" ? "ok  " : file.status === "changed" ? "DIFF" : "GONE";
        const detail =
          file.status === "unchanged"
            ? `unchanged since ${report.recordedAt}`
            : file.status === "changed"
              ? `expected ${file.expected.slice(0, 12)}…, got ${(file.actual ?? "").slice(0, 12)}…`
              : `no such path at ${report.release}`;
        return `  ${mark}  ${file.path}\n        ${detail}\n        ${file.why}`;
      })
      .join("\n");

  return (
    `format tier (the pyk behaviour this package reimplements):\n${tierOf("format")}\n\n` +
    `content tier (what the K binaries accept — advisory):\n${tierOf("content")}\n\n` +
    `${summaryFor(report.verdicts.format, "format")}\n` +
    `${summaryFor(report.verdicts.content, "content (advisory)")}\n`
  );
}

/** Maps the format-tier verdict to this command's contractual exit code. */
export function exitCodeFor(verdict: KtoolSourcesVerdict): number {
  return verdict === "unchanged" ? 0 : verdict === "changed" ? 1 : 3;
}

async function mainCheckK(
  args: readonly string[],
  out: (text: string) => void,
  err: (text: string) => void,
  fetcher: KtoolSourceFetcher,
): Promise<number> {
  const [release, ...rest] = args;
  if (release === undefined || rest.length > 0) {
    err(`check-k takes exactly one K release tag, e.g. ${K_RELEASE}\n`);
    return 2;
  }

  let report: KtoolSourcesReport;
  try {
    report = await checkKtoolSources(release, fetcher);
  } catch (error) {
    // Failing to reach GitHub is "could not ask", which is neither a pass nor a
    // fail — reporting it as either would be a lie about K.
    err(`could not check ${release}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  out(render(report));
  return exitCodeFor(report.verdicts.format);
}

//////////////////////////////
// Entry point              //
//////////////////////////////

interface KtoolCliContext extends CommandContext {
  readonly process: StricliProcess;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  readonly fetcher: KtoolSourceFetcher;
}

function finish(context: KtoolCliContext, code: number): void {
  context.process.exitCode = code;
}

function parsedString(brief: string, placeholder = "value") {
  return { kind: "parsed", parse: String, brief, placeholder, optional: true } as const;
}

function parsedStrings(brief: string, placeholder = "value", separator: true | string = true) {
  return { kind: "parsed", parse: String, brief, placeholder, optional: true, variadic: separator } as const;
}

function booleanFlag(brief: string) {
  return { kind: "boolean", brief, optional: true } as const;
}

function positionalParameter(brief: string, placeholder: string) {
  return { parse: String, brief, placeholder } as const;
}

function appendValue(argv: string[], flag: string, value: string | number | undefined): void {
  if (value !== undefined) argv.push(flag, String(value));
}

function appendValues(argv: string[], flag: string, values: readonly string[] | undefined): void {
  for (const value of values ?? []) argv.push(flag, value);
}

interface KompileCliFlags {
  readonly backend: KompileBackend;
  readonly mainModule?: string;
  readonly syntaxModule?: string;
  readonly include?: readonly string[];
  readonly mdSelector?: string;
  readonly hookNamespaces?: readonly string[];
  readonly emitJson: boolean;
  readonly genBisonParser?: boolean;
  readonly genGlrBisonParser?: boolean;
  readonly bisonParserLibrary?: boolean;
  readonly bisonLists?: boolean;
  readonly postProcess?: string;
  readonly readOnlyKompiledDirectory?: boolean;
  readonly coverage?: boolean;
  readonly outerParsedJson?: boolean;
  readonly topCell?: string;
  readonly llvmKompileType?: LLVMKompileType;
  readonly llvmKompileOutput?: string;
  readonly optLevel?: number;
  readonly ccopt?: readonly string[];
  readonly noLlvmKompile?: boolean;
  readonly enableSearch?: boolean;
  readonly enableLlvmDebug?: boolean;
  readonly heuristic?: string;
  readonly iteratedThreshold?: string;
  readonly concreteRules?: readonly string[];
  readonly haskellBinary: boolean;
  readonly outputDefinition?: string;
  readonly tempDir?: string;
  readonly typeInferenceMode?: TypeInferenceMode;
  readonly warnings?: Warnings;
  readonly warningsToErrors?: boolean;
  readonly noExcWrap?: boolean;
  readonly ignoreWarning?: readonly string[];
  readonly verbose?: boolean;
  readonly debug?: boolean;
  readonly dryRun?: boolean;
}

const kompileCommand = buildCommand<KompileCliFlags, [string], KtoolCliContext>({
  docs: {
    brief: "Compile a K definition",
    fullDescription:
      "Compile a K definition and print its output directory. Diagnostics are mirrored as they arrive; --dry-run prints the executable argv without spawning.",
  },
  parameters: {
    aliases: { I: "include", o: "outputDefinition" },
    flags: {
      backend: { kind: "enum", values: KOMPILE_BACKENDS, default: "llvm", brief: "K backend" },
      mainModule: parsedString("Main module", "module"),
      syntaxModule: parsedString("Syntax module", "module"),
      include: parsedStrings("Definition include directory", "directory"),
      mdSelector: parsedString("Markdown selector", "selector"),
      hookNamespaces: parsedStrings("Hook namespace", "namespace"),
      emitJson: { kind: "boolean", default: true, brief: "Emit compiled.json" },
      genBisonParser: booleanFlag("Generate a deterministic Bison parser"),
      genGlrBisonParser: booleanFlag("Generate a GLR Bison parser"),
      bisonParserLibrary: booleanFlag("Generate the Bison parser as a library"),
      bisonLists: booleanFlag("Use Bison list lowering"),
      postProcess: parsedString("Post-process command", "command"),
      readOnlyKompiledDirectory: booleanFlag("Mark the kompiled directory read-only"),
      coverage: booleanFlag("Enable coverage instrumentation"),
      outerParsedJson: booleanFlag("Read an outer-parsed JSON definition"),
      topCell: parsedString("Top-cell sort", "sort"),
      llvmKompileType: { kind: "enum", values: LLVM_KOMPILE_TYPES, optional: true, brief: "LLVM output kind" },
      llvmKompileOutput: parsedString("LLVM output file", "file"),
      optLevel: {
        kind: "parsed",
        parse: (value) => {
          const parsed = Number(value);
          if (!Number.isInteger(parsed) || parsed < 0 || parsed > 3) throw new Error("expected 0, 1, 2, or 3");
          return parsed;
        },
        brief: "LLVM optimization level",
        placeholder: "0..3",
        optional: true,
      },
      ccopt: parsedStrings("Option passed to the C compiler", "option"),
      noLlvmKompile: booleanFlag("Skip llvm-kompile"),
      enableSearch: booleanFlag("Enable LLVM search"),
      enableLlvmDebug: booleanFlag("Enable LLVM debug information"),
      heuristic: parsedString("LLVM decision-tree heuristic", "heuristic"),
      iteratedThreshold: parsedString("LLVM iterated threshold", "fraction"),
      concreteRules: parsedStrings("Haskell concrete rule", "label", ","),
      haskellBinary: { kind: "boolean", default: true, brief: "Build the Haskell binary" },
      outputDefinition: parsedString("Output definition directory", "directory"),
      tempDir: parsedString("Temporary directory", "directory"),
      typeInferenceMode: {
        kind: "enum",
        values: TYPE_INFERENCE_MODES,
        optional: true,
        brief: "Type inference mode",
      },
      warnings: { kind: "enum", values: WARNINGS, optional: true, brief: "Warning level" },
      warningsToErrors: booleanFlag("Treat warnings as errors"),
      noExcWrap: booleanFlag("Do not wrap exception messages"),
      ignoreWarning: parsedStrings("Warning code to ignore", "code", ","),
      verbose: booleanFlag("Print verbose tool output"),
      debug: booleanFlag("Retain K temporary artifacts"),
      dryRun: booleanFlag("Print argv and spawn nothing"),
    },
    positional: { kind: "tuple", parameters: [positionalParameter("K definition", "main-file")] },
  },
  func: async function (flags, mainFile) {
    const argv = [mainFile, "--backend", flags.backend];
    appendValue(argv, "--main-module", flags.mainModule);
    appendValue(argv, "--syntax-module", flags.syntaxModule);
    appendValues(argv, "--include", flags.include);
    appendValue(argv, "--md-selector", flags.mdSelector);
    appendValues(argv, "--hook-namespaces", flags.hookNamespaces);
    if (!flags.emitJson) argv.push("--no-emit-json");
    if (flags.genBisonParser === true) argv.push("--gen-bison-parser");
    if (flags.genGlrBisonParser === true) argv.push("--gen-glr-bison-parser");
    if (flags.bisonParserLibrary === true) argv.push("--bison-parser-library");
    if (flags.bisonLists === true) argv.push("--bison-lists");
    appendValue(argv, "--post-process", flags.postProcess);
    if (flags.readOnlyKompiledDirectory === true) argv.push("--read-only-kompiled-directory");
    if (flags.coverage === true) argv.push("--coverage");
    if (flags.outerParsedJson === true) argv.push("--outer-parsed-json");
    appendValue(argv, "--top-cell", flags.topCell);
    appendValue(argv, "--llvm-kompile-type", flags.llvmKompileType);
    appendValue(argv, "--llvm-kompile-output", flags.llvmKompileOutput);
    if (flags.optLevel !== undefined) argv.push(`-O${flags.optLevel}`);
    appendValues(argv, "-ccopt", flags.ccopt);
    if (flags.noLlvmKompile === true) argv.push("--no-llvm-kompile");
    if (flags.enableSearch === true) argv.push("--enable-search");
    if (flags.enableLlvmDebug === true) argv.push("--enable-llvm-debug");
    appendValue(argv, "--heuristic", flags.heuristic);
    appendValue(argv, "--iterated-threshold", flags.iteratedThreshold);
    appendValues(argv, "--concrete-rules", flags.concreteRules);
    if (!flags.haskellBinary) argv.push("--no-haskell-binary");
    appendValue(argv, "--output-definition", flags.outputDefinition);
    appendValue(argv, "--temp-dir", flags.tempDir);
    appendValue(argv, "--type-inference-mode", flags.typeInferenceMode);
    appendValue(argv, "--warnings", flags.warnings);
    if (flags.warningsToErrors === true) argv.push("--warnings-to-errors");
    if (flags.noExcWrap === true) argv.push("--no-exc-wrap");
    appendValues(argv, "-Wno", flags.ignoreWarning);
    if (flags.verbose === true) argv.push("--verbose");
    if (flags.debug === true) argv.push("--debug");
    if (flags.dryRun === true) argv.push("--dry-run");
    finish(this, await mainKompile(argv, this.out, this.err));
  },
});

interface RunCliFlags {
  readonly input?: RunInput;
  readonly depth?: number;
  readonly output: RunOutput;
  readonly krun?: boolean;
  readonly parser?: string;
}

const runCommand = buildCommand<RunCliFlags, [string, string], KtoolCliContext>({
  docs: { brief: "Run a program or KORE configuration" },
  parameters: {
    flags: {
      input: { kind: "enum", values: RUN_INPUTS, optional: true, brief: "Input kind" },
      depth: {
        kind: "parsed",
        parse: (value) => {
          const parsed = nonNegativeInt("--depth", value);
          if (typeof parsed === "string") throw new Error(parsed);
          return parsed;
        },
        brief: "Maximum rewrite depth",
        optional: true,
      },
      output: { kind: "enum", values: RUN_OUTPUTS, default: "pretty", brief: "Output format" },
      krun: booleanFlag("Use krun even when a native interpreter exists"),
      parser: parsedString("Program parser command", "command"),
    },
    positional: {
      kind: "tuple",
      parameters: [
        positionalParameter("Kompiled definition directory", "kompiled-dir"),
        positionalParameter("Input file", "file"),
      ],
    },
  },
  func: async function (flags, definitionDir, file) {
    const argv = [definitionDir, file, "--output", flags.output];
    appendValue(argv, "--input", flags.input);
    appendValue(argv, "--depth", flags.depth);
    if (flags.krun === true) argv.push("--krun");
    appendValue(argv, "--parser", flags.parser);
    finish(this, await mainRun(argv, this.out, this.err));
  },
});

interface ParseCliFlags {
  readonly sort: string;
  readonly file?: boolean;
  readonly asRule?: boolean;
  readonly output: ParseOutput;
}

const parseCommand = buildCommand<ParseCliFlags, [string, string], KtoolCliContext>({
  docs: { brief: "Parse program text through kast" },
  parameters: {
    flags: {
      sort: { kind: "parsed", parse: String, brief: "Start sort", placeholder: "sort" },
      file: booleanFlag("Read the text positional as a path"),
      asRule: booleanFlag("Allow rule syntax and variables"),
      output: { kind: "enum", values: PARSE_OUTPUTS, default: "json", brief: "Output format" },
    },
    positional: {
      kind: "tuple",
      parameters: [
        positionalParameter("Kompiled definition directory", "kompiled-dir"),
        positionalParameter("Text or path", "text"),
      ],
    },
  },
  func: async function (flags, definitionDir, text) {
    const argv = [definitionDir, text, "--sort", flags.sort, "--output", flags.output];
    if (flags.file === true) argv.push("--file");
    if (flags.asRule === true) argv.push("--as-rule");
    finish(this, await mainParse(argv, this.out, this.err));
  },
});

interface ClaimsCliFlags {
  readonly definition: string;
  readonly specModule?: string;
  readonly mdSelector?: string;
  readonly typeInferenceMode?: TypeInferenceMode;
  readonly builtinDir?: string;
  readonly include?: readonly string[];
  readonly labels?: readonly string[];
  readonly exclude?: readonly string[];
  readonly depends: boolean;
  readonly ordered?: boolean;
  readonly verbose?: boolean;
}

const claimsCommand = buildCommand<ClaimsCliFlags, [string], KtoolCliContext>({
  docs: { brief: "Resolve claim labels from a specification" },
  parameters: {
    aliases: { I: "include" },
    flags: {
      definition: { kind: "parsed", parse: String, brief: "Kompiled definition directory", placeholder: "directory" },
      specModule: parsedString("Specification module", "module"),
      mdSelector: parsedString("Markdown selector", "selector"),
      typeInferenceMode: {
        kind: "enum",
        values: TYPE_INFERENCE_MODES,
        optional: true,
        brief: "Type inference mode",
      },
      builtinDir: parsedString("K builtin directory", "directory"),
      include: parsedStrings("Specification include directory", "directory"),
      labels: parsedStrings("Claim label", "label", ","),
      exclude: parsedStrings("Claim label to exclude", "label", ","),
      depends: { kind: "boolean", default: true, brief: "Close selection over claim dependencies" },
      ordered: booleanFlag("Print dependencies before dependants"),
      verbose: booleanFlag("Trace cache decisions"),
    },
    positional: { kind: "tuple", parameters: [positionalParameter("K specification", "spec-file")] },
  },
  func: async function (flags, specFile) {
    const argv = [specFile, "--definition", flags.definition];
    appendValue(argv, "--spec-module", flags.specModule);
    appendValue(argv, "--md-selector", flags.mdSelector);
    appendValue(argv, "--type-inference-mode", flags.typeInferenceMode);
    appendValue(argv, "--builtin-dir", flags.builtinDir);
    appendValues(argv, "--include", flags.include);
    appendValues(argv, "--labels", flags.labels);
    appendValues(argv, "--exclude", flags.exclude);
    if (!flags.depends) argv.push("--no-depends");
    if (flags.ordered === true) argv.push("--ordered");
    if (flags.verbose === true) argv.push("--verbose");
    finish(this, await mainClaims(argv, this.out, this.err));
  },
});

const checkKCommand = buildCommand<NonNullable<unknown>, [string], KtoolCliContext>({
  docs: { brief: "Check the upstream source identities for a K release" },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [positionalParameter(`K release (for example ${K_RELEASE})`, "k-release")],
    },
  },
  func: async function (_flags, release) {
    finish(this, await mainCheckK([release], this.out, this.err, this.fetcher));
  },
});

interface Lr1BisonFlags {
  readonly bison: string;
  readonly tempDir?: string;
  readonly timeoutMs?: number;
  readonly compact?: boolean;
}

interface Lr1KFlags extends Lr1BisonFlags {
  readonly kompile: string;
  readonly backend: "llvm" | "haskell" | "maude";
  readonly mainModule?: string;
  readonly syntaxModule?: string;
  readonly include?: readonly string[];
  readonly mdSelector?: string;
  readonly hookNamespaces?: readonly string[];
  readonly bisonLists?: boolean;
  readonly topCell?: string;
  readonly temporaryParent?: string;
  readonly retainArtifactsTo?: string;
}

function timeoutFlag() {
  return {
    kind: "parsed",
    parse: (value: string) => {
      const parsed = nonNegativeInt("--timeout-ms", value);
      if (typeof parsed === "string" || parsed === 0) throw new Error("--timeout-ms takes a positive integer");
      return parsed;
    },
    brief: "Per-process timeout in milliseconds",
    placeholder: "milliseconds",
    optional: true,
  } as const;
}

function printLr1Json(context: KtoolCliContext, value: unknown, compact: boolean | undefined): void {
  const wire = KtoolLr1JsonSchema.parse(value);
  context.out(`${JSON.stringify(wire, undefined, compact === true ? undefined : 2)}\n`);
}

const lr1BisonCommand = buildCommand<Lr1BisonFlags, [string], KtoolCliContext>({
  docs: {
    brief: "Classify an existing Bison grammar as LR(1)",
    fullDescription: "Analyze the exact bytes of an existing parser.y with the supported GNU Bison IELR adapter.",
  },
  parameters: {
    flags: {
      bison: {
        kind: "parsed",
        parse: String,
        default: "bison",
        brief: "GNU Bison executable",
        placeholder: "executable",
      },
      tempDir: parsedString("Parent for the analyzer workspace", "directory"),
      timeoutMs: timeoutFlag(),
      compact: booleanFlag("Emit compact single-line JSON"),
    },
    positional: { kind: "tuple", parameters: [positionalParameter("Bison grammar", "grammar.y")] },
  },
  func: async function (flags, grammar) {
    try {
      const analysis = await analyzeBisonLr1File({
        path: grammar,
        tool: { command: [flags.bison] },
        ...(flags.tempDir === undefined ? {} : { tempDir: flags.tempDir }),
        ...(flags.timeoutMs === undefined ? {} : { timeoutMs: flags.timeoutMs }),
      });
      printLr1Json(this, bisonLr1Json(analysis), flags.compact);
      finish(this, analysis.classification.kind === "lr1" ? 0 : 1);
    } catch (error: unknown) {
      this.err(`${error instanceof Error ? error.message : String(error)}\n`);
      finish(this, 1);
    }
  },
});

const lr1KCommand = buildCommand<Lr1KFlags, [string], KtoolCliContext>({
  docs: {
    brief: "Generate a K definition's PGM grammar and classify it as LR(1)",
    fullDescription:
      "Run deterministic K parser capture, then classify the exact generated Bison grammar with the independent IELR analyzer.",
  },
  parameters: {
    aliases: { I: "include" },
    flags: {
      bison: {
        kind: "parsed",
        parse: String,
        default: "bison",
        brief: "GNU Bison executable",
        placeholder: "executable",
      },
      tempDir: parsedString("Parent for the Bison analyzer workspace", "directory"),
      timeoutMs: timeoutFlag(),
      compact: booleanFlag("Emit compact single-line JSON"),
      kompile: {
        kind: "parsed",
        parse: String,
        default: "kompile",
        brief: "K kompile executable",
        placeholder: "executable",
      },
      backend: {
        kind: "enum",
        values: ["llvm", "haskell", "maude"],
        default: "haskell",
        brief: "Backend used for parser capture",
      },
      mainModule: parsedString("Main module", "module"),
      syntaxModule: parsedString("Syntax module", "module"),
      include: parsedStrings("Definition include directory", "directory"),
      mdSelector: parsedString("Markdown selector", "selector"),
      hookNamespaces: parsedStrings("Hook namespace", "namespace"),
      bisonLists: booleanFlag("Use Bison list lowering in the generated grammar"),
      topCell: parsedString("Top-cell sort", "sort"),
      temporaryParent: parsedString("Parent for K's capture workspace", "directory"),
      retainArtifactsTo: parsedString("Fresh absolute destination for capture artifacts", "directory"),
    },
    positional: { kind: "tuple", parameters: [positionalParameter("K definition", "main-file")] },
  },
  func: async function (flags, mainFile) {
    try {
      const common = {
        mainFile,
        ...(flags.mainModule === undefined ? {} : { mainModule: flags.mainModule }),
        ...(flags.syntaxModule === undefined ? {} : { syntaxModule: flags.syntaxModule }),
        ...(flags.include === undefined ? {} : { includeDirs: flags.include }),
        ...(flags.mdSelector === undefined ? {} : { mdSelector: flags.mdSelector }),
        ...(flags.hookNamespaces === undefined ? {} : { hookNamespaces: flags.hookNamespaces }),
        ...(flags.bisonLists === true ? { bisonLists: true } : {}),
        ...(flags.topCell === undefined ? {} : { topCell: flags.topCell }),
      };
      const spec: KompileSpec =
        flags.backend === "haskell"
          ? { ...common, backend: "haskell", haskellBinary: false }
          : flags.backend === "llvm"
            ? { ...common, backend: "llvm", noLlvmKompile: true }
            : { ...common, backend: "maude" };
      const controls = flags.timeoutMs === undefined ? {} : { timeoutMs: flags.timeoutMs };
      const check = await checkKGrammarLr1(spec, {
        capture: {
          command: [flags.kompile],
          ...controls,
          ...(flags.temporaryParent === undefined ? {} : { temporaryParent: flags.temporaryParent }),
          ...(flags.retainArtifactsTo === undefined ? {} : { retainArtifactsTo: flags.retainArtifactsTo }),
        },
        bison: {
          tool: { command: [flags.bison] },
          ...controls,
          ...(flags.tempDir === undefined ? {} : { tempDir: flags.tempDir }),
        },
      });
      printLr1Json(this, kGrammarLr1Json(check), flags.compact);
      finish(this, check.analysis.classification.kind === "lr1" ? 0 : 1);
    } catch (error: unknown) {
      this.err(`${error instanceof Error ? error.message : String(error)}\n`);
      finish(this, 1);
    }
  },
});

const lr1Routes = buildRouteMap({
  docs: { brief: "Classify Bison or K grammars as LR(1)" },
  routes: { bison: lr1BisonCommand, k: lr1KCommand },
});

export const application = buildApplication(
  buildRouteMap({
    docs: { brief: "Run and inspect K Framework tools" },
    routes: {
      kompile: kompileCommand,
      run: runCommand,
      parse: parseCommand,
      claims: claimsCommand,
      "check-k": checkKCommand,
      lr1: lr1Routes,
    },
  }),
  {
    name: "ktool",
    scanner: { caseStyle: "allow-kebab-for-camel", allowArgumentEscapeSequence: true },
    documentation: { disableAnsiColor: true },
  },
);

/** Normalize K's historical multi-character single-dash options for Stricli. */
function normalizeLegacyFlags(argv: readonly string[]): readonly string[] {
  if (argv[0] !== "kompile") return argv;
  const normalized: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    const optimization = /^-O([0-3])$/u.exec(arg);
    if (optimization !== null) {
      normalized.push("--opt-level", optimization[1] ?? "0");
    } else if (arg === "-ccopt") {
      const value = argv[index + 1];
      if (value === undefined) {
        normalized.push("--ccopt");
      } else {
        normalized.push(`--ccopt=${value}`);
        index += 1;
      }
    } else if (arg === "-Wno") {
      normalized.push("--ignore-warning");
    } else {
      normalized.push(arg);
    }
  }
  return normalized;
}

/**
 * Run the Stricli application against injected streams. Negative Stricli
 * framework codes are projected onto ktool's established usage exit code 2.
 */
export async function main(
  argv: readonly string[],
  out: (text: string) => void,
  err: (text: string) => void,
  fetcher: KtoolSourceFetcher = fetchFromGitHub,
): Promise<number> {
  const cliProcess: StricliProcess = {
    stdout: { write: out },
    stderr: { write: err },
    env: process.env,
  };
  const context: KtoolCliContext = { process: cliProcess, out, err, fetcher };
  if (argv.length === 0) {
    const usageProcess: StricliProcess = { ...cliProcess, stdout: { write: err } };
    await runStricli(application, ["--help"], { ...context, process: usageProcess });
    return 2;
  }
  await runStricli(application, normalizeLegacyFlags(argv), context);
  const code = typeof cliProcess.exitCode === "number" ? cliProcess.exitCode : 0;
  return code < 0 ? 2 : code;
}
