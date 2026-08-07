/**
 * `kprove`'s argv, and the one `kprove` invocation that is worth having before
 * the rest of the prover is ported: `KProve.parse_modules`
 * (`pyk/ktool/kprove.py:255-278`) at K **v7.1.337**.
 *
 * This module invokes `kprove` only for `parse_modules`; proving is provided by
 * `@kframework-ts/proof`'s RPC `proveClaims`. `parse_modules` is the only
 * operation `ClaimLoader` needs, and it parses rather than proves. `--dry-run`
 * means K stops
 * before invoking a backend, so no `kore-exec` runs and no proof is attempted;
 * `--emit-json-spec` is what makes the parse observable.
 *
 * # The invocation, spelled out
 *
 * ```
 * kprove <spec> --definition <dir> [--spec-module M] [--md-selector S] [-I D]…
 *        --output json [--type-inference-mode M] [--temp-dir T]
 *        --dry-run --emit-json-spec <tmp> --allow-rules
 * ```
 *
 * That order is not a choice.  {@link buildKproveArgv} transcribes
 * `_build_arg_list` (`kprove.py:104-155`) flag by flag, and
 * {@link kproveParseModulesArgs} then fixes the subset `parse_modules` uses.
 * Two things about it are easy to get wrong:
 *
 * - **`--emit-json-spec` appears at the end, not in its `_build_arg_list`
 *   slot.**  `parse_modules` passes `emit_json_spec=None` to the typed builder
 *   and puts `['--emit-json-spec', tmp, '--allow-rules']` in the free-form
 *   `args` tail instead (`kprove.py:271-274`), which lands *after* `--dry-run`.
 *   Transcribed, because argv goldens are only worth having if they are exact.
 * - **`--allow-rules`** is why a spec file containing `rule`s parses at all.
 *
 * # `--depth` diverges from krun, in the opposite direction
 *
 * `_build_arg_list` writes `if depth:` (`kprove.py:149`), so **`--depth 0` is
 * not emitted** — a falsy `0` is indistinguishable from "not given".  `krun`'s
 * builder writes `if depth is not None:` and *does* emit `--depth 0`
 * (`krun.py:400`).  Both are transcribed as written,
 * in their own modules, and both are pinned by an argv table.  This is a real
 * upstream inconsistency, not a porting error; `parse_modules` passes no depth
 * at all, so nothing here depends on it.
 *
 * # Deliberate divergences
 *
 * | upstream | here | why |
 * | --- | --- | --- |
 * | `NamedTemporaryFile` in `use_directory`, deleted unless persisting | `mkdtemp` + a named file inside it, removed in a `finally` | Node has no `delete=False` NamedTemporaryFile; a directory of our own is the portable spelling and cleans up in one call |
 * | the emitted file is read while still open | read after the process exits | the process has to have finished for the file to be complete either way |
 * | `KProveOutput` as an `Enum` | a string union | the monorepo convention (`kompile.ts`'s `TypeInferenceMode`, `kompiled`'s `KompileBackend`): the values *are* the wire format |
 */

import { flatModuleListFromDict, type KFlatModuleList } from "@kframework-ts/kast";
import { openEnvelopeText } from "@kframework-ts/kast-json";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import type { ModuleParser, ParseModulesOptions } from "./claim-loader.js";
import type { TypeInferenceMode } from "./kompile.js";
import { checkDirPath, checkFilePath, runProcess, type ProcessControlOptions, type ProcessLogger } from "./proc.js";
import type { ProcessRunner } from "./kore-print.js";

//////////////////////////////
// The argv table           //
//////////////////////////////

/** `--output` — `KProveOutput` (`kprove.py:38-46`). */
export const KPROVE_OUTPUTS = ["pretty", "program", "KAST", "binary", "json", "latex", "kore", "none"] as const;
export type KProveOutput = (typeof KPROVE_OUTPUTS)[number];

/**
 * Every typed argument `_kprove` accepts (`kprove.py:88-155`), minus the spec
 * file, the command and the free-form tail.
 *
 * Field order here is emission order, which is the property the golden table
 * checks.
 */
export interface KproveArgs {
  /** `--definition`. */
  readonly definitionDir?: string;
  /** `--spec-module`. */
  readonly specModuleName?: string;
  /** `--md-selector`. */
  readonly mdSelector?: string;
  /** `-I`, repeated in order. */
  readonly includeDirs?: readonly string[];
  /** `--emit-json-spec`. */
  readonly emitJsonSpec?: string;
  /** `--output`. */
  readonly output?: KProveOutput;
  /** `--claims`, comma-joined.  An empty list emits nothing. */
  readonly claims?: readonly string[];
  /** `--type-inference-mode`. */
  readonly typeInferenceMode?: TypeInferenceMode;
  /** `--temp-dir`. */
  readonly tempDir?: string;
  /** `--haskell-backend-command`. */
  readonly haskellBackendCommand?: string;
  /**
   * `--depth`.
   *
   * **`0` emits nothing** — upstream's `if depth:` (`kprove.py:149`).  See the
   * module header: `krun` does the opposite with the same field name.
   */
  readonly depth?: number;
  /** `--dry-run`. */
  readonly dryRun?: boolean;
}

/**
 * `_build_arg_list` (`kprove.py:120-155`) — the typed flags, in emission order.
 *
 * Every test upstream writes as `if x:` is transcribed as a truthiness test,
 * not as `!== undefined`: an empty `--spec-module ''` or an empty include list
 * emits nothing in Python and emits nothing here.
 */
export function buildKproveTypedArgs(args: KproveArgs): string[] {
  const argv: string[] = [];

  if (args.definitionDir !== undefined && args.definitionDir !== "") argv.push("--definition", args.definitionDir);
  if (args.specModuleName !== undefined && args.specModuleName !== "") {
    argv.push("--spec-module", args.specModuleName);
  }
  if (args.mdSelector !== undefined && args.mdSelector !== "") argv.push("--md-selector", args.mdSelector);
  for (const includeDir of args.includeDirs ?? []) argv.push("-I", includeDir);
  if (args.emitJsonSpec !== undefined && args.emitJsonSpec !== "") argv.push("--emit-json-spec", args.emitJsonSpec);
  if (args.output !== undefined) argv.push("--output", args.output);
  if (args.claims !== undefined && args.claims.length > 0) argv.push("--claims", args.claims.join(","));
  if (args.typeInferenceMode !== undefined) argv.push("--type-inference-mode", args.typeInferenceMode);
  if (args.tempDir !== undefined && args.tempDir !== "") argv.push("--temp-dir", args.tempDir);
  if (args.haskellBackendCommand !== undefined && args.haskellBackendCommand !== "") {
    argv.push("--haskell-backend-command", args.haskellBackendCommand);
  }
  // `if depth:` — 0 is falsy, so `--depth 0` is NOT emitted.  Deliberate; see
  // the module header.
  if (args.depth !== undefined && args.depth !== 0) argv.push("--depth", String(args.depth));
  if (args.dryRun === true) argv.push("--dry-run");

  return argv;
}

/**
 * The whole argv `_kprove` runs (`kprove.py:112-116`):
 * `command + [spec] + typed_args + args`.
 *
 * `extraArgs` is the free-form tail, and it lands **after** every typed flag —
 * which is where `--emit-json-spec`/`--allow-rules` end up for
 * {@link kproveParseModulesArgs}.
 */
export function buildKproveArgv(
  specFile: string,
  args: KproveArgs = {},
  extraArgs: readonly string[] = [],
  command: readonly string[] = ["kprove"],
): string[] {
  return [...command, specFile, ...buildKproveTypedArgs(args), ...extraArgs];
}

//////////////////////////////
// parse_modules            //
//////////////////////////////

/** What {@link kproveParseModulesArgs} and {@link parseModules} need beyond the spec file. */
export interface ParseModulesArgs extends ParseModulesOptions {
  /** `--definition` — the `*-kompiled/` directory K resolves the spec against. */
  readonly definitionDir: string;
  /**
   * `--temp-dir`, `KProve.use_directory` upstream.  Omitted emits nothing and
   * lets K choose.
   */
  readonly tempDir?: string;
  /** `kprove`, unless overridden.  A list, so a wrapper (`nix run …`) fits. */
  readonly command?: readonly string[];
}

/**
 * The exact argv `KProve.parse_modules` runs (`kprove.py:262-275`).
 *
 * `emitJsonSpec` is the file K is told to write the parsed `KFlatModuleList`
 * to; {@link parseModules} makes a temporary one and reads it back.  It is a
 * required parameter rather than an option because an invocation without it
 * produces nothing.
 */
export function kproveParseModulesArgs(specFile: string, emitJsonSpec: string, args: ParseModulesArgs): string[] {
  return buildKproveArgv(
    specFile,
    {
      definitionDir: args.definitionDir,
      ...(args.specModuleName === undefined ? {} : { specModuleName: args.specModuleName }),
      ...(args.includeDirs === undefined ? {} : { includeDirs: args.includeDirs }),
      ...(args.mdSelector === undefined ? {} : { mdSelector: args.mdSelector }),
      output: "json",
      ...(args.typeInferenceMode === undefined ? {} : { typeInferenceMode: args.typeInferenceMode }),
      ...(args.tempDir === undefined ? {} : { tempDir: args.tempDir }),
      dryRun: true,
    },
    ["--emit-json-spec", emitJsonSpec, "--allow-rules"],
    args.command ?? ["kprove"],
  );
}

/** What {@link parseModules} accepts beyond {@link ParseModulesArgs}. */
export interface ParseModulesRunOptions extends ProcessControlOptions {
  readonly logger?: ProcessLogger;
  /** Mirror `kprove`'s stderr onto ours while still capturing it. */
  readonly teeStderr?: boolean;
  readonly runner?: ProcessRunner;
}

/**
 * Run `kprove --dry-run --emit-json-spec` and decode the module list it wrote —
 * `KProve.parse_modules` (`kprove.py:255-278`).
 *
 * The preconditions are `_kprove`'s (`kprove.py:107-110`): the spec file must
 * exist and every include directory must be a directory, both checked *before*
 * a process is created, because a `spawn` failure cannot say which one was
 * wrong.
 *
 * The emitted file carries the KAST envelope (`kast_term`, `kprove.py:277`), so
 * it is opened through `kast-json` and only then decoded as a
 * `KFlatModuleList`.
 *
 * @throws {ProcessError} when `kprove` exits non-zero.
 * @throws {Error} when the emitted file is not a readable KAST envelope.
 */
export async function parseModules(
  specFile: string,
  args: ParseModulesArgs,
  options: ParseModulesRunOptions = {},
): Promise<KFlatModuleList> {
  await checkFilePath(specFile);
  for (const includeDir of args.includeDirs ?? []) await checkDirPath(includeDir);

  // `self._temp_file(prefix=f'{file_path.name}.parsed.json.')` (`kprove.py:262`),
  // in `use_directory` when one is set.
  const parent = args.tempDir ?? tmpdir();
  const dir = await mkdtemp(join(parent, "ktool-parse-modules-"));
  try {
    const emitted = join(dir, `${basename(specFile)}.parsed.json`);
    await (options.runner ?? runProcess)(kproveParseModulesArgs(specFile, emitted, args), {
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      ...(options.teeStderr === undefined ? {} : { teeStderr: options.teeStderr }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.killGraceMs === undefined ? {} : { killGraceMs: options.killGraceMs }),
    });
    return decodeModuleList(await readFile(emitted, "utf8"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * `KFlatModuleList.from_dict(kast_term(json_data))` (`kprove.py:277`) — the
 * envelope check and the decode, as one function.
 *
 * Separate and exported so a checked-in `--emit-json-spec` golden can be read
 * back in a test with no process involved, which is exactly what
 * `fixtures/generated/*.modulelist.json` is for.
 */
export function decodeModuleList(text: string): KFlatModuleList {
  const envelope = openEnvelopeText(text);
  if (!envelope.ok) throw new Error(`Not a readable KAST document: ${envelope.problem.message}`);
  return flatModuleListFromDict(envelope.term);
}

//////////////////////////////
// The ModuleParser impl    //
//////////////////////////////

/**
 * {@link ModuleParser} backed by a real `kprove` — the default implementation
 * `ClaimLoader` is built for, and the reason its seam exists as an interface.
 *
 * The definition directory and the command are fixed at construction (they are
 * `KProve` instance state upstream); everything `ClaimLoader` varies per call
 * arrives through {@link ParseModulesOptions}.
 */
export class KproveModuleParser implements ModuleParser {
  readonly #args: Omit<ParseModulesArgs, keyof ParseModulesOptions>;
  readonly #options: ParseModulesRunOptions;

  constructor(args: Omit<ParseModulesArgs, keyof ParseModulesOptions>, options: ParseModulesRunOptions = {}) {
    this.#args = args;
    this.#options = options;
  }

  // Not `async`: the free `parseModules` here is the module-level function, and
  // returning its promise directly is one less microtask than re-awaiting it.
  parseModules(specFile: string, options: ParseModulesOptions = {}): Promise<KFlatModuleList> {
    return parseModules(
      specFile,
      { ...this.#args, ...options },
      {
        ...this.#options,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.killGraceMs === undefined ? {} : { killGraceMs: options.killGraceMs }),
      },
    );
  }
}
