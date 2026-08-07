/**
 * `kparse` — parsing a program at a sort, through the **native Bison parser**
 * when `kompile` generated one, and through the JVM only when it did not.
 *
 * **pyk has nothing to transcribe here.** `grep -r 'parser_\|kparse' pyk/src/`
 * at K `v7.1.337` finds only `Kompile`'s `--gen-bison-parser` /
 * `--gen-glr-bison-parser` *flags* and `kprint.gen_glr_parser`, which builds a
 * parser and then never looks for one: every parse in pyk goes through `kast`,
 * i.e. through a JVM. The specification for this module is the K
 * distribution's own dispatcher,
 * `k-distribution/src/main/scripts/bin/kparse`, and the line numbers below cite
 * it.
 *
 * # The lookup rule, verbatim
 *
 * `kparse` is 209 lines of argument parsing around six lines of decision:
 *
 * | `kparse` | rule |
 * | --- | --- |
 * | `:164-167` | no `syntaxDefinition.kore` in the directory → hand the whole argv to `kast --output kore` and stop |
 * | `:179-181` | `--module` defaults to the contents of `mainSyntaxModule.txt` |
 * | `:183-190` | `--sort` defaults to `declaredConfigVar_PGM` from `configVars.sh`, or `KItem` when there is no `$PGM` |
 * | `:194-195` | the parser is `<kompiledDir>/parser_<Sort>_<Module>`, and it is used **only if executable** |
 * | `:196` | exec it as `parser <file>`; its stdout is the KORE term |
 * | `:198` | otherwise fall back to `kast --output kore` |
 * | `:202-203` | `--input kore` is answered by `cat` — no process at all |
 * | `:206-207` | every other `--input` mode goes to `kast` unconditionally |
 *
 * {@link resolveKparseTarget} is rows 2 and 3 and is **pure**;
 * {@link findBisonParser} is rows 1 and 4; {@link kparse} is the dispatcher.
 *
 * # Why this is the largest speedup in the package
 *
 * Measured on this repo's `tiny.k` fixture at K `v7.1.337`, parsing
 * `1 + 2 + 3`:
 *
 * | route | wall clock | note |
 * | --- | --- | --- |
 * | `kast --input program --output kore` | **1 255 ms** | cold JVM |
 * | the same, against a warm kserver | **280 ms** | see `kserver.ts` |
 * | `parser_Exp_TINY-SYNTAX` | **0.8 ms** | native, and the two outputs are byte-identical |
 *
 * That is ~1 500× against a cold JVM and ~350× against a warm one, and the
 * outputs are the same string — which is not a coincidence but the reason the
 * dispatcher is allowed to exist: the generated parser is built from the same
 * grammar by `KSyntax2Bison`, and `include/kframework/cparser/main.c` is the
 * shared C runtime that does the KORE enquoting and `inj{}` synthesis.
 *
 * A caller only gets this if the definition was kompiled with
 * `--gen-bison-parser` or `--gen-glr-bison-parser`; `kparse-gen` builds one
 * after the fact for any sort/module without re-kompiling. When there is no
 * parser, everything here degrades to exactly the `kast` call the rest of this
 * package would have made.
 *
 * # Deliberate divergences from the script
 *
 * | `kparse` | here | why |
 * | --- | --- | --- |
 * | resolves the kompiled directory by globbing `*-kompiled` in `.` (`:145-162`) | {@link KparseOptions.definitionDir} is required | `findKompiledDir` in `@kframework-ts/kompiled` is that glob, exported, and a library that guesses a directory from `process.cwd()` is a library that surprises you |
 * | `--input binary` is advertised (`:82`) | it is in {@link KAstInput} and simply forwarded to `kast` | the mode is dead upstream (`kore-print`/`kparse` help text still advertises it), and this module is not the place to litigate it |
 * | positional `-` means `/dev/stdin` (`:169-170`) | {@link KparseOptions.text} is written to a **temp file** whose path goes in the argv | `/dev/stdin` is not openable by a child Node or Bun spawned — `stdio.ts` has the evidence — so the shell's spelling is unavailable.  {@link KparseOptions.locationFile} defaults to `/dev/stdin` so that the `Source(…)` attributes a `text` parse produces are *stable*, rather than naming a random temp path |
 * | stdout is emitted as the child produced it | **trimmed** | the native parser appends a bare `printf("\n")` (`main.c:318`) and `kast` appends its own newline; trimming is what makes the two routes return the *same* string, which is the whole premise |
 */

import { access, readFile, readlink } from "node:fs/promises";
import { accessSync, constants as fsConstants } from "node:fs";
import { join } from "node:path";

import {
  bisonParserName as kompiledBisonParserName,
  expectedBisonParserArtifacts,
  loadKompiledLayout,
  type KompiledLayout,
} from "@kframework-ts/kompiled";

import { kastArgs, type KAstInput, type RunKastOptions } from "./kast-cli.js";
import type { ProcessRunner } from "./kore-print.js";
import { checkDirPath, checkFilePath, runProcess, type ProcessControlOptions, type ProcessLogger } from "./proc.js";
import { DEV_STDIN, withStdinFile } from "./stdio.js";

//////////////////////////////
// Pure: names and defaults //
//////////////////////////////

/** The configuration variable whose sort is `kparse`'s default (`kparse:185-188`). */
export const PGM_CONFIG_VAR = "PGM" as const;

/** The sort `kparse` falls back to when a definition declares no `$PGM` (`kparse:186`). */
export const DEFAULT_PARSE_SORT = "KItem" as const;

/**
 * `parser_<Sort>_<Module>` — the filename `kompile --gen-bison-parser` writes
 * (`kparse:194`).
 *
 * Neither component is escaped, because neither can contain a path separator: a
 * K sorts and module names use identifiers whose observed generated spelling
 * permits `_` and `-`, but never `.`. The observed shape on a real build is `parser_Exp_TINY-SYNTAX`,
 * beside the symlinks `parser_PGM` and `parser_<cellName>` that `kompile` also
 * makes — this package never follows those, because the script does not: the
 * symlink targets are only correct for the *default* sort and module, and
 * resolving the real name costs nothing.
 */
export const bisonParserName = kompiledBisonParserName;

/** {@link bisonParserName}, joined onto the kompiled directory. */
export function bisonParserPath(definitionDir: string, sort: string, module: string): string {
  return join(definitionDir, bisonParserName(sort, module));
}

/** A caller's partial answer to "which sort, in which module?". */
export interface KparseTargetQuery {
  /** `--sort`. Absent takes `$PGM`'s declared sort, or `KItem`. */
  readonly sort?: string;
  /** `--module`. Absent takes `mainSyntaxModule.txt`. */
  readonly module?: string;
}

/** A resolved parse target: both halves present. */
export interface KparseTarget {
  readonly sort: string;
  readonly module: string;
}

/**
 * Fill in `--sort` and `--module` the way `kparse` fills them in
 * (`:179-190`). Pure — it reads a `KompiledLayout`, not a directory.
 *
 * The `$PGM` lookup is `declaredConfigVar_PGM` from `configVars.sh`, which
 * `@kframework-ts/kompiled` has already parsed into
 * `layout.configVarSorts`. Note the script's exact fallback: it is
 * `KItem` when there is *no* `$PGM`, not when `configVars.sh` is missing — a
 * directory with no `configVars.sh` at all reaches the same answer here only
 * because an unparsed file yields an empty map, which is what the script's
 * `source` of a nonexistent file would also do (it would in fact abort, being
 * `set -e`; the difference is unreachable, since `kompile` always writes the
 * file).
 */
export function resolveKparseTarget(layout: KompiledLayout, query: KparseTargetQuery = {}): KparseTarget {
  return {
    sort: query.sort ?? layout.configVarSorts.get(PGM_CONFIG_VAR) ?? DEFAULT_PARSE_SORT,
    module: query.module ?? layout.mainSyntaxModule,
  };
}

//////////////////////////////
// Lookup                   //
//////////////////////////////

/** A native parser that exists and can be executed. */
export interface BisonParser extends KparseTarget {
  /** The absolute-or-as-given path to `parser_<Sort>_<Module>`. */
  readonly path: string;
}

/**
 * The native parser for a target, or `undefined` — `kparse:164-167,194-195`.
 *
 * Both of the script's conditions are checked, in its order:
 *
 * 1. `syntaxDefinition.kore` must exist in the directory. Its absence means the
 *    definition was built by a pipeline that cannot have generated parsers, and
 *    the script bails to `kast` before it even computes a sort.
 * 2. `parser_<Sort>_<Module>` must exist **and be executable** (`[ -x ]`). A
 *    non-executable file of that name is not a parser; K's own check is the
 *    permission bit and so is this one.
 *
 * Cheap enough to call per parse — two `access` syscalls — but
 * {@link KparseOptions} lets a caller in a tight loop pass a resolved
 * {@link BisonParser} straight through.
 */
export async function findBisonParser(
  definitionDir: string,
  layout: KompiledLayout,
  query: KparseTargetQuery = {},
): Promise<BisonParser | undefined> {
  if (!(await exists(join(definitionDir, "syntaxDefinition.kore")))) return undefined;
  const target = resolveKparseTarget(layout, query);
  const path = bisonParserPath(definitionDir, target.sort, target.module);
  return (await isExecutable(path)) ? { ...target, path } : undefined;
}

/** Runtime classification of an expected parser artifact; unlike `kompiled`, this checks executability. */
export type BisonParserDiscovery =
  | { readonly kind: "executable"; readonly parser: BisonParser }
  | { readonly kind: "library"; readonly sort: string; readonly module: string; readonly path: string }
  | { readonly kind: "backend-no-concrete-parser"; readonly backend: string }
  | { readonly kind: "not-generated"; readonly reason: "missing-syntax-definition" | "absent" | "not-executable" };

/** One forward-derived artifact inspection, including aliases' readlink agreement. */
export type ListedBisonParserArtifact =
  | { readonly kind: "executable"; readonly parser: BisonParser }
  | { readonly kind: "library"; readonly sort: string; readonly module: string; readonly path: string }
  | {
      readonly kind: "alias";
      readonly configVar: string;
      readonly path: string;
      readonly target: string | undefined;
      readonly expectedTargets: readonly string[];
      readonly agreement: "match" | "mismatch" | "not-link" | "missing";
    };

/** Classify the parser for one target without guessing from filenames. */
export async function discoverBisonParser(
  definitionDir: string,
  layout: KompiledLayout,
  query: KparseTargetQuery = {},
): Promise<BisonParserDiscovery> {
  if (!(await exists(join(definitionDir, "syntaxDefinition.kore")))) {
    return { kind: "backend-no-concrete-parser", backend: layout.backend };
  }
  const target = resolveKparseTarget(layout, query);
  const executable = bisonParserPath(definitionDir, target.sort, target.module);
  if (await isExecutable(executable)) return { kind: "executable", parser: { ...target, path: executable } };
  const artifact = expectedBisonParserArtifacts(layout).find(
    (entry) => entry.kind === "concrete" && entry.sort === target.sort && entry.module === target.module,
  );
  if (artifact?.kind === "concrete" && (await exists(join(definitionDir, artifact.library)))) {
    return { kind: "library", ...target, path: join(definitionDir, artifact.library) };
  }
  return { kind: "not-generated", reason: (await exists(executable)) ? "not-executable" : "absent" };
}

/** Synchronous counterpart for consumers whose own API is synchronous. */
export function findBisonParserSync(
  definitionDir: string,
  layout: KompiledLayout,
  query: KparseTargetQuery = {},
): BisonParser | undefined {
  try {
    accessSync(join(definitionDir, "syntaxDefinition.kore"));
    const target = resolveKparseTarget(layout, query);
    const path = bisonParserPath(definitionDir, target.sort, target.module);
    accessSync(path, fsConstants.X_OK);
    return { ...target, path };
  } catch {
    return undefined;
  }
}

/** List generated executable parsers by deriving every expected name from the layout; no directory entry is parsed. */
export async function listBisonParsers(definitionDir: string, layout: KompiledLayout): Promise<readonly BisonParser[]> {
  if (!(await exists(join(definitionDir, "syntaxDefinition.kore")))) return [];
  const parsers: BisonParser[] = [];
  for (const artifact of expectedBisonParserArtifacts(layout)) {
    if (artifact.kind !== "concrete") continue;
    const path = join(definitionDir, artifact.executable);
    if (await isExecutable(path)) parsers.push({ sort: artifact.sort, module: artifact.module, path });
  }
  return parsers;
}

/**
 * List expected parsers and aliases derived from `KompiledLayout`.
 *
 * Aliases are not classified from their filename: each path and allowed target
 * comes from `kompiled`'s descriptor, then `readlink` merely checks that K's
 * convenience link agrees. Missing aliases are normal; a mismatch is exposed
 * for callers diagnosing the known K sort-string discrepancy.
 */
export async function listBisonParserArtifacts(
  definitionDir: string,
  layout: KompiledLayout,
): Promise<readonly ListedBisonParserArtifact[]> {
  const result: ListedBisonParserArtifact[] = [];
  for (const artifact of expectedBisonParserArtifacts(layout)) {
    if (artifact.kind === "concrete") {
      const executable = join(definitionDir, artifact.executable);
      if (await isExecutable(executable)) {
        result.push({ kind: "executable", parser: { sort: artifact.sort, module: artifact.module, path: executable } });
      } else if (await exists(join(definitionDir, artifact.library))) {
        result.push({
          kind: "library",
          sort: artifact.sort,
          module: artifact.module,
          path: join(definitionDir, artifact.library),
        });
      }
      continue;
    }
    const path = join(definitionDir, artifact.file);
    let target: string | undefined;
    let agreement: "match" | "mismatch" | "not-link" | "missing" = "missing";
    try {
      target = await readlink(path);
      agreement = artifact.expectedTargets.includes(target) ? "match" : "mismatch";
    } catch {
      if (await exists(path)) agreement = "not-link";
      else agreement = "missing";
    }
    result.push({
      kind: "alias",
      configVar: artifact.configVar,
      path,
      target,
      expectedTargets: artifact.expectedTargets,
      agreement,
    });
  }
  return result;
}

//////////////////////////////
// The dispatcher           //
//////////////////////////////

/** {@link kparse}'s options. */
export interface KparseOptions extends KparseTargetQuery, ProcessControlOptions {
  /** The `*-kompiled` directory. Required — see the divergence table. */
  readonly definitionDir: string;
  /**
   * The layout, when the caller already has one (`KPrint.kompiled.layout`,
   * say). Omitted, it is read from `definitionDir` — which is two small file
   * reads, not a `compiled.json` parse.
   */
  readonly layout?: KompiledLayout;
  /** A parser already resolved by {@link findBisonParser}; skips the lookup. */
  readonly parser?: BisonParser;
  /** `--input`. Defaults to `program`, the only mode with a fast path (`kparse:192`). */
  readonly input?: KAstInput;
  /** The file to parse. Mutually exclusive with {@link text}. */
  readonly file?: string;
  /** The program text, delivered on the child's stdin. Mutually exclusive with {@link file}. */
  readonly text?: string;
  /**
   * `argv[2]` of the native parser: the filename that appears in `Source(…)`
   * attributes and error messages (`cparser/main.c:310-316`).
   *
   * `kparse` never passes it, so for a {@link file} parse this defaults to
   * absent and locations name the file — upstream's behaviour. For a
   * {@link text} parse it defaults to {@link DEV_STDIN}, which is what `kparse
   * -` would have reported and, more importantly, is *stable*: without it every
   * run would stamp a different temp path into the term's attributes. Ignored
   * on the `kast` fallback, which has no equivalent.
   */
  readonly locationFile?: string;
  /** The `kast` command for the fallback. Defaults to `['kast']`. */
  readonly command?: readonly string[];
  /**
   * Refuse the native parser and always use `kast`.
   *
   * The reason to want this is differential testing — proving the two routes
   * agree on a corpus — which is exactly the check that licenses the fast path
   * being the default.
   */
  readonly native?: boolean;
  /** Faithful only on the JVM `kast` fallback; native parsers do not accept this JVM option. */
  readonly noExcWrap?: boolean;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly logger?: ProcessLogger;
  /** Throw on a non-zero exit. Defaults to `true`. */
  readonly check?: boolean;
  /** Test seam — see {@link ProcessRunner}. */
  readonly runner?: ProcessRunner;
}

/** What {@link kparse} did, and what came back. */
export interface KparseResult {
  /** The KORE term, trimmed — see the divergence table. */
  readonly kore: string;
  /**
   * The native parser that produced it, or `undefined` when `kast` did.
   *
   * This is the field an acceptance test asserts on: `parser !== undefined` is
   * the machine-checkable statement "no JVM was started for this parse".
   */
  readonly parser: BisonParser | undefined;
}

/**
 * Parse a program to KORE — `k-distribution/src/main/scripts/bin/kparse`.
 *
 * ```ts
 * const { kore, parser } = await kparse({ definitionDir, text: "1 + 2", sort: "Exp" });
 * parser?.path; // "…/tiny-kompiled/parser_Exp_TINY-SYNTAX" — or undefined, if kast did it
 * ```
 *
 * `input: 'kore'` returns the input unchanged and starts nothing, which is the
 * script's `cat` (`:202-203`) and the same short-circuit `korePrint` makes for
 * `output: 'kore'`.
 *
 * @throws {Error} when neither or both of `file` and `text` are given, when
 *   `definitionDir` is not a directory, or when `file` does not exist.
 * @throws {import('./proc.js').ProcessError} when the parser (native or JVM)
 *   rejects the input and `check` is not `false`.
 */
export async function kparse(options: KparseOptions): Promise<KparseResult> {
  const hasFile = options.file !== undefined && options.file !== "";
  const hasText = options.text !== undefined;
  if (hasFile === hasText) {
    throw new Error("kparse needs exactly one of `file` and `text`");
  }

  const input = options.input ?? "program";
  // `:202-203` — `--input kore` is `output "$outputFile" cat "$input_file"`.
  // No child and no lookup; a `file` still has to be read, because `cat` reads
  // it, and this is the one branch where the answer is the input itself.
  if (input === "kore") {
    if (!hasFile) return { kore: (options.text ?? "").trim(), parser: undefined };
    await checkFilePath(options.file ?? "");
    return { kore: (await readFile(options.file ?? "", "utf8")).trim(), parser: undefined };
  }

  await checkDirPath(options.definitionDir);
  if (hasFile) await checkFilePath(options.file ?? "");

  const parser = input === "program" && options.native !== false ? await resolveParser(options) : undefined;
  const run = options.runner ?? runProcess;
  const childOptions = {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.killGraceMs === undefined ? {} : { killGraceMs: options.killGraceMs }),
    check: options.check !== false,
  };

  // Both routes take a *path*, and both of them therefore need a real file when
  // the caller supplied text — see the divergence table.
  const withInput = <T>(body: (file: string) => Promise<T>): Promise<T> =>
    hasFile ? body(options.file ?? "") : withStdinFile(options.text ?? "", { prefix: "kparse-", suffix: ".pgm" }, body);

  if (parser !== undefined) {
    // `:196` — `output "$outputFile" execute "$bisonParser" "$input_file"`.
    const location = options.locationFile ?? (hasFile ? undefined : DEV_STDIN);
    const result = await withInput((file) =>
      run([parser.path, file, ...(location === undefined ? [] : [location])], childOptions),
    );
    return { kore: result.stdout.trim(), parser };
  }

  // `:198`/`:207` — `execute "$KAST_UTIL" --output kore "${ORIG_ARGV[@]}"`, i.e.
  // the caller's sort and module as given, *not* the resolved defaults: `kast`
  // has its own defaulting and reproducing ours on top would be two policies.
  const result = await withInput((file) =>
    run(
      kastArgs({
        ...(options.command === undefined ? {} : { command: options.command }),
        file,
        definitionDir: options.definitionDir,
        input,
        output: "kore",
        ...(options.module === undefined ? {} : { module: options.module }),
        ...(options.sort === undefined ? {} : { sort: options.sort }),
        ...(options.noExcWrap === true ? { noExcWrap: true } : {}),
      } satisfies RunKastOptions),
      childOptions,
    ),
  );
  return { kore: result.stdout.trim(), parser: undefined };
}

async function resolveParser(options: KparseOptions): Promise<BisonParser | undefined> {
  if (options.parser !== undefined) return options.parser;
  // Deliberately `loadKompiledLayout` and not `loadKompiledDefinitionCached`:
  // the lookup needs `mainSyntaxModule.txt` and `configVars.sh`, and pulling in
  // a `compiled.json` parse to decide whether to avoid a JVM would be an own
  // goal.  A caller who already has a definition passes `layout`.
  const layout = options.layout ?? (await loadKompiledLayout(options.definitionDir));
  const query: KparseTargetQuery = {
    ...(options.sort === undefined ? {} : { sort: options.sort }),
    ...(options.module === undefined ? {} : { module: options.module }),
  };
  return findBisonParser(options.definitionDir, layout, query);
}

//////////////////////////////
// Predicates               //
//////////////////////////////

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** `[ -x "$bisonParser" ]` (`kparse:195`) — the same `access(X_OK)` `distribution.ts` uses. */
async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}
