/**
 * The `ktool` command: five subcommands, each a thin shell over the library.
 *
 * The rule this file is written to, and the reason the CLI stayed minimal
 * where `pyk`'s is large: **no logic here that is not in the library**.  Every
 * subcommand parses
 * flags into the option objects `src/*.ts` already defines, calls one exported
 * function, and renders what comes back.  The flag parsers are pure and
 * exported ({@link parseKompileArgs}, {@link parseRunArgs},
 * {@link parseParseArgs}, {@link parseClaimsArgs}), which is what makes the
 * mapping testable with no K installed — `ktool kompile … --dry-run` prints the
 * argv {@link buildKompileArgv} would have run and spawns nothing.
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

import { claimDependencies, kastTermToDict, ksort, ktoken, sentenceLabel, type KInner } from "@kframework-ts/kast";
import { koreText, KoreParser, type Pattern } from "@kframework-ts/kore";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { ClaimIndexError, staticOrder } from "./claim-index.js";
import { ClaimLoader, type LoadClaimsOptions } from "./claim-loader.js";
import { getKDistribution } from "./distribution.js";
import { llvmInterpret } from "./interpreter.js";
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

export const USAGE = `ktool <command>

  ktool kompile <main-file> [flags]
      Compile a K definition and print the output directory. --backend defaults
      to llvm; --emit-json is ON unless --no-emit-json, which is pyk's default
      and not the CLI's — see the README. kompile's own output is mirrored onto
      this process's streams. --dry-run prints the argv and spawns nothing.

      common   --main-module M  --syntax-module M  -I DIR  --md-selector S
               --hook-namespaces NS  --no-emit-json  --gen-bison-parser
               --gen-glr-bison-parser  --bison-parser-library  --bison-lists
               --post-process CMD  --coverage  --top-cell S  --outer-parsed-json
               --read-only-kompiled-directory
      call     -o DIR / --output-definition DIR  --temp-dir DIR
               --type-inference-mode M  --warnings W  --warnings-to-errors
               --no-exc-wrap  -Wno CODES  --verbose  --debug
      llvm     -O0 -O1 -O2 -O3  --llvm-kompile-type T  --llvm-kompile-output F
               -ccopt OPT  --no-llvm-kompile  --enable-search
               --enable-llvm-debug  --heuristic H  --iterated-threshold N/D
      haskell  --concrete-rules R  --no-haskell-binary

  ktool run <kompiled-dir> <file> [flags]
      Rewrite a program or a KORE configuration to its final state.

      --input kore|program  defaults to kore for a .kore file, program otherwise
      --depth N             maximal rewrite steps
      --output FMT          ${RUN_OUTPUTS.join(" ")} (default pretty)
      --krun                use krun even when the definition has an interpreter
      --parser CMD          the command krun pipes $PGM through (program input)

      A kore input goes through <dir>/interpreter when there is one — no K on
      PATH required — and through 'krun --term' otherwise; the two agree.
      --output kore and --output json are rendered in process; the rest go
      through kore-print.

  ktool parse <kompiled-dir> <text> --sort S [flags]
      Parse program text at a sort, through the kast binary.

      --sort S       required; the sort to parse at
      --file         read <text> as a path instead of taking it literally
      --as-rule      parse as rule syntax, so variables are allowed
      --output FMT   json (default), pretty or kore

  ktool claims <spec.k> --definition DIR [flags]
      List the claim labels a spec file resolves to, loading and caching
      <spec>.json beside it.

      --definition DIR    the *-kompiled directory kprove parses against
      --spec-module M     --md-selector S  -I DIR  --type-inference-mode M
      --builtin-dir DIR   K's include/kframework/builtin; found on PATH if K is
      --labels A,B        only these labels (repeatable, comma-separated)
      --exclude A,B       drop these, and prune their dependencies
      --no-depends        do not close the selection over depends()
      --ordered           topological order, dependencies first
      --verbose           trace the cache decision on stderr

  ktool check-k <k-release>
      Check whether the upstream sources this package was transcribed from are
      unchanged at a given K release, e.g. ktool check-k ${K_RELEASE}.

Exit codes: 0 success, 1 the operation failed, 2 could not run (usage). For
check-k the format tier decides: 0 unchanged, 1 changed, 3 could not locate,
2 could not ask. Content-tier drift (what the K binaries actually accept) is
printed as advisory and does not affect the exit code.`;

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
    err(`kompile ${parsed}\n\n${USAGE}\n`);
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
    err(`run ${parsed}\n\n${USAGE}\n`);
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
    err(`parse ${parsed}\n\n${USAGE}\n`);
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
    err(`claims ${parsed}\n\n${USAGE}\n`);
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
    err(`check-k takes exactly one K release tag, e.g. ${K_RELEASE}\n\n${USAGE}\n`);
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

/**
 * The whole command.
 *
 * The fetcher defaults to GitHub; passing it is what lets `check-k` be tested
 * offline.  Everything else reaches the real filesystem and the real K, because
 * a seam for those would be a seam for the one thing this package exists to do.
 */
export function main(
  argv: readonly string[],
  out: (text: string) => void,
  err: (text: string) => void,
  fetcher: KtoolSourceFetcher = fetchFromGitHub,
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
  if (command === "kompile") return mainKompile(args, out, err);
  if (command === "run") return mainRun(args, out, err);
  if (command === "parse") return mainParse(args, out, err);
  if (command === "claims") return mainClaims(args, out, err);
  if (command === "check-k") return mainCheckK(args, out, err, fetcher);

  err(`unknown command: ${command}\n\n${USAGE}\n`);
  return Promise.resolve(2);
}
