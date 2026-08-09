/**
 * `kompile` — the argv, and the spawn.
 *
 * A transcription of `pyk/ktool/kompile.py` (668 lines) at K `v7.1.337`, plus
 * `TypeInferenceMode` from `pyk/ktool/_ktool.py`.  Everything above
 * {@link kompile} is **pure**: given a spec it returns a `string[]` and touches
 * nothing, which is what makes the flag order testable with no K installed.
 * That is the whole point of splitting it this way, and it is how pyk is split
 * too — `KompileArgs.args()` and each backend's `args()` are pure; only
 * `Kompile.__call__` spawns.
 *
 * # Shape: a discriminated union, not a class hierarchy
 *
 * pyk models this as an abstract `Kompile` with three `@dataclass` subclasses,
 * each holding a shared `KompileArgs` — because Python needs somewhere to put
 * `**kwargs` partitioning at runtime.  TypeScript does not: {@link KompileSpec}
 * is a union discriminated on `backend`, so `concreteRules` on an `llvm` spec
 * is a compile error rather than a runtime `ValueError`.  The dynamic door is
 * still open — {@link kompileFromDict} is `Kompile.from_dict`, for callers
 * holding a `Record<string, unknown>` (a kdist-style build plugin, a CLI) —
 * and it raises on an unknown key exactly as pyk does.
 *
 * # The quirk ledger, applied
 *
 * None of these is load-bearing upstream — each is a pyk accident — so the port
 * diverges and records the verdict here, where a later drift check finds it
 * instead of re-litigating it.
 *
 * | quirk | upstream | here |
 * | --- | --- | --- |
 * | `--outer-parsed-json` emitted twice when both the spec and the call ask | `:329` + `:631` | emitted **once** — {@link buildKompileArgv} |
 * | `shlex.quote` on `--post-process` with no shell in sight | `:620` | **not quoted**; the literal `'…'` upstream produces reaches `kompile` as part of the value |
 * | output dir defaults relative to the **process CWD**, not the main file's directory and not `cwd:` | `:356-357` | **kept** — see {@link defaultOutputDir} |
 * | `'Invalid optimization level: {opt_level}'` — an f-string that isn't | `:459` | fixed; the number is in the message |
 * | `_group_args` silently drops keys it does not recognise | `:185-198` | {@link boosterKompile} **throws** |
 *
 * And three orderings pinned here because they are load-bearing and easy to
 * "tidy" wrongly: `--hook-namespaces` takes the names **space-joined into one
 * argv element** (`:605`); `-Wno` takes its codes **comma-joined into one
 * element**, with the flag as a separate element (`:333`); `-O<n>` is emitted
 * **only for a non-zero level** (`:492`), so `optLevel: 0` means "say nothing",
 * not `-O0`.
 */

import { LLVM_LIBRARY_DIR, findKompiledDir } from "@kframework-ts/kompiled";
import { stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";

import { resolveOnPath } from "./distribution.js";
import {
  absOrRelTo,
  checkDirPath,
  checkFilePath,
  runProcess,
  type CompletedProcess,
  type ProcessControlOptions,
  type ProcessLogger,
} from "./proc.js";

//////////////////////////////
// Enumerations             //
//////////////////////////////

/**
 * `--type-inference-mode` — `TypeInferenceMode` (`ktool/_ktool.py:4-8`).
 *
 * Modelled as a string union plus a `const` array rather than an `enum`, which
 * is this monorepo's convention (`kompiled`'s `KompileBackend`, `kore-rpc`'s
 * log-entry kinds): the values *are* the wire format, so a nominal type would
 * only get in the way of a caller that read one out of a config file.
 */
export const TYPE_INFERENCE_MODES = ["z3", "simplesub", "checked", "default"] as const;
export type TypeInferenceMode = (typeof TYPE_INFERENCE_MODES)[number];

/** `--backend` — `KompileBackend` (`ktool/kompile.py:206-210`). */
export const KOMPILE_BACKENDS = ["llvm", "haskell", "kore", "maude"] as const;
export type KompileBackend = (typeof KOMPILE_BACKENDS)[number];

/**
 * `PykBackend` (`ktool/kompile.py:35-40`) — the four real backends plus
 * `booster`, which is not a backend at all but a *pair* of kompilations; see
 * {@link boosterKompile}.
 */
export const PYK_BACKENDS = [...KOMPILE_BACKENDS, "booster"] as const;
export type PykBackend = (typeof PYK_BACKENDS)[number];

/** `--warnings` — `Warnings` (`ktool/kompile.py:43-46`). */
export const WARNINGS = ["all", "normal", "none"] as const;
export type Warnings = (typeof WARNINGS)[number];

/** `--llvm-kompile-type` — `LLVMKompileType` (`ktool/kompile.py:409-415`). */
export const LLVM_KOMPILE_TYPES = ["main", "search", "library", "static", "python", "c"] as const;
export type LLVMKompileType = (typeof LLVM_KOMPILE_TYPES)[number];

//////////////////////////////
// Errors                   //
//////////////////////////////

/**
 * `command[0]` is not on `PATH` — `KompileNotFoundError`
 * (`ktool/kompile.py:30-32`).
 *
 * Thrown **before** any process is created, which is the property worth having:
 * an ENOENT out of `spawn` cannot distinguish a missing `kompile` from a
 * missing `cwd`, and by then the caller has already paid for a fork.
 */
export class KompileNotFoundError extends Error {
  /** The command name that could not be resolved. */
  readonly command: string;

  constructor(command: string) {
    super(`Kompile command not found: ${command}`);
    this.name = "KompileNotFoundError";
    this.command = command;
  }
}

/**
 * A spec is not well-formed: an unknown key, an unusable backend, an
 * optimisation level out of range.
 *
 * Stands in for the `ValueError`s pyk raises at `:129`, `:255`, `:266` and
 * `:459`.  The *conditions* are pyk's exactly; the messages are ours, because
 * nothing downstream greps them and pyk's `{opt_level}` one is a broken
 * f-string anyway.
 */
export class KompileArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KompileArgumentError";
  }
}

//////////////////////////////
// The spec                 //
//////////////////////////////

/**
 * The backend-independent options — `KompileArgs` (`ktool/kompile.py:528-587`).
 *
 * Two defaults are worth naming because they are not the CLI's:
 *
 * - **{@link emitJson} defaults to `true`** (`:557`), where the Java frontend
 *   defaults it to `false` (`KompileOptions.java:159-161`).  This is why every
 *   pyk-built definition has a `compiled.json` and every hand-built one does
 *   not — and therefore why `@kframework-ts/kompiled` can read the former and
 *   throws `MissingCompiledJsonError` on the latter.
 * - **{@link includeDirs} is sorted** before emission (`:569`), so `-I` order
 *   is a function of the set and not of the caller's array.
 */
export interface KompileArgs {
  /** The `.k` (or `.md`) definition to compile.  The one positional argument. */
  readonly mainFile: string;
  /** `--main-module`. */
  readonly mainModule?: string;
  /** `--syntax-module`. */
  readonly syntaxModule?: string;
  /** `-I`, one flag per directory, **sorted** — see {@link sortIncludeDirs}. */
  readonly includeDirs?: readonly string[];
  /** `--md-selector`. */
  readonly mdSelector?: string;
  /** `--hook-namespaces`, space-joined into a single argv element (`:605`). */
  readonly hookNamespaces?: readonly string[];
  /** `--emit-json`.  **Defaults to `true`**, unlike the CLI. */
  readonly emitJson?: boolean;
  /** `--gen-bison-parser`. */
  readonly genBisonParser?: boolean;
  /** `--gen-glr-bison-parser`. */
  readonly genGlrBisonParser?: boolean;
  /** `--bison-parser-library`. */
  readonly bisonParserLibrary?: boolean;
  /**
   * `--post-process` — a command K runs over the compiled definition.
   *
   * Passed through **unquoted**.  pyk `shlex.quote`s it (`:620`) into an argv
   * that no shell will ever see, so `echo "hi"` reaches `kompile` as
   * `'echo "hi"'`, single quotes and all.  See the module header.
   */
  readonly postProcess?: string;
  /** `--read-only-kompiled-directory` (note the flag is not `--read-only`). */
  readonly readOnly?: boolean;
  /** `--coverage`. */
  readonly coverage?: boolean;
  /** `--bison-lists`. */
  readonly bisonLists?: boolean;
  /** `--outer-parsed-json`.  Also reachable per-call; emitted at most once. */
  readonly outerParsedJson?: boolean;
  /** `--top-cell`. */
  readonly topCell?: string;
}

/** The LLVM backend's options — `LLVMKompile` (`ktool/kompile.py:418-525`). */
export interface LLVMKompileOptions {
  /** `--llvm-kompile-type`. */
  readonly llvmKompileType?: LLVMKompileType;
  /** `--llvm-kompile-output`. */
  readonly llvmKompileOutput?: string;
  /**
   * `-O<n>`, `0`–`3`.
   *
   * `0` emits **nothing** (`:492` tests truthiness), so it is "leave the
   * default alone" and not `-O0`.  Out of range throws
   * {@link KompileArgumentError}.
   */
  readonly optLevel?: number;
  /** `-ccopt`, one flag per option (`:495-496`). */
  readonly ccopts?: readonly string[];
  /** `--no-llvm-kompile`. */
  readonly noLlvmKompile?: boolean;
  /** `--enable-search`. */
  readonly enableSearch?: boolean;
  /** `--enable-llvm-debug`. */
  readonly enableLlvmDebug?: boolean;
  /** `--llvm-proof-hint-instrumentation`. */
  readonly llvmProofHintInstrumentation?: boolean;
  /** `--llvm-proof-hint-debugging`. */
  readonly llvmProofHintDebugging?: boolean;
  /** `--llvm-hidden-visibility`. */
  readonly llvmHiddenVisibility?: boolean;
  /** `--llvm-mutable-bytes`. */
  readonly llvmMutableBytes?: boolean;
  /**
   * `--iterated-threshold` — **a string**, where pyk takes a
   * `fractions.Fraction` and emits `str(...)` of it (`:519-520`).
   *
   * The flag's value is a rational written `n/d` (the LLVM backend's decision
   * tree heuristic reads it that way), and JavaScript has no `Fraction`.
   * Inventing one to hold a value that is only ever stringified would be a
   * dependency for nothing, so the string *is* the type: pass `"1/2"`.
   *
   * One behavioural consequence, since pyk gates on truthiness: `Fraction(0)`
   * is falsy in Python and the flag is dropped, whereas the string `"0"` is
   * truthy here and **is** emitted.  `""` is the spelling for "drop it".
   */
  readonly iteratedThreshold?: string;
  /** `--heuristic`. */
  readonly heuristic?: string;
}

/** The Haskell backend's options — `HaskellKompile` (`ktool/kompile.py:360-387`). */
export interface HaskellKompileOptions {
  /** `--concrete-rules`, comma-joined into a single argv element (`:382`). */
  readonly concreteRules?: readonly string[];
  /** **Defaults to `true`**; `false` emits `--no-haskell-binary` (`:384-385`). */
  readonly haskellBinary?: boolean;
}

/**
 * What to compile and how — the union `Kompile.from_dict` builds at runtime
 * (`ktool/kompile.py:241-266`), made a compile-time one.
 *
 * `kore` is deliberately absent: pyk's `from_dict` accepts the *name* and then
 * falls through to `raise ValueError(f'Unsupported backend: kore')` (`:265-266`),
 * so a `kore` spec has never been constructible.  `booster` is absent for a
 * different reason — it is not a backend; see {@link boosterKompile}.
 */
export type KompileSpec =
  | (KompileArgs & LLVMKompileOptions & { readonly backend: "llvm" })
  | (KompileArgs & HaskellKompileOptions & { readonly backend: "haskell" })
  | (KompileArgs & { readonly backend: "maude" });

//////////////////////////////
// Key inventories          //
//////////////////////////////

/**
 * `COMMON_ARGS` (`ktool/kompile.py:640`) — the field names of `KompileArgs`,
 * which `from_dict` and `_group_args` partition on.
 *
 * Spelled in **camelCase**, this package's spelling.  A dict whose keys are
 * pyk's `snake_case` will be rejected key by key, which is the right outcome:
 * silently accepting both would make `emit_json` and `emitJson` two ways to
 * set one flag and neither of them the documented one.
 */
export const COMMON_ARG_KEYS = [
  "mainFile",
  "mainModule",
  "syntaxModule",
  "includeDirs",
  "mdSelector",
  "hookNamespaces",
  "emitJson",
  "genBisonParser",
  "genGlrBisonParser",
  "bisonParserLibrary",
  "postProcess",
  "readOnly",
  "coverage",
  "bisonLists",
  "outerParsedJson",
  "topCell",
] as const;

/** `KompileBackend.LLVM.args` (`:215-216`). */
export const LLVM_ARG_KEYS = [
  "llvmKompileType",
  "llvmKompileOutput",
  "optLevel",
  "ccopts",
  "noLlvmKompile",
  "enableSearch",
  "enableLlvmDebug",
  "llvmProofHintInstrumentation",
  "llvmProofHintDebugging",
  "llvmHiddenVisibility",
  "llvmMutableBytes",
  "iteratedThreshold",
  "heuristic",
] as const;

/** `KompileBackend.HASKELL.args` (`:217-220`). */
export const HASKELL_ARG_KEYS = ["concreteRules", "haskellBinary"] as const;

/**
 * The Maude backend takes no options of its own — `MaudeKompile`
 * (`ktool/kompile.py:390-406`) has no fields beyond `base_args`.
 *
 * Note that `KompileBackend.MAUDE.args` **raises** upstream (`:221-222`), so
 * `from_dict` on a maude dict with any backend key raises `ValueError` from a
 * `match` arm that reads like an oversight.  The observable behaviour — maude
 * accepts no backend arguments — is the same, so nothing here diverges; only
 * the error's spelling does.
 */
export const MAUDE_ARG_KEYS = [] as const;

/** Whether an arbitrary value is one of the four names `--backend` accepts. */
export function isKompileBackend(value: unknown): value is KompileBackend {
  return typeof value === "string" && (KOMPILE_BACKENDS as readonly string[]).includes(value);
}

/** Which key set a backend's options come from — `KompileBackend.args` (`:212-222`). */
export function backendArgKeys(backend: KompileBackend): readonly string[] {
  switch (backend) {
    case "llvm":
      return LLVM_ARG_KEYS;
    case "haskell":
      return HASKELL_ARG_KEYS;
    // `maude` has none, and `kore` has no class to build at all (`:221-222`).
    default:
      return MAUDE_ARG_KEYS;
  }
}

//////////////////////////////
// Pure argv construction   //
//////////////////////////////

/** A string option is emitted only when it is present and non-empty — pyk gates on truthiness throughout. */
function present(value: string | undefined): value is string {
  return value !== undefined && value !== "";
}

/**
 * `sorted(Path(d) for d in include_dirs)` (`ktool/kompile.py:569`), as a plain
 * lexicographic sort of the strings.
 *
 * Two divergences, both from *not* going through `pathlib`:
 *
 * - Python compares `PurePath`s **part by part**, so `/a/b` sorts before
 *   `/a.c` (`'a' < 'a.c'`) while a string sort puts `/a.c` first (`'.' < '/'`).
 *   Ordinary include paths — a set of directories, usually siblings — order
 *   identically under both.
 * - `Path('./lib')` normalises to `lib` and `Path('a//b')` to `a/b`, so pyk's
 *   argv can differ from what the caller wrote.  Ours never does: the string
 *   goes to `kompile` as given, and `kompile` resolves it.
 *
 * Only `-I` order is observable either way, and `kompile` treats `-I` as a set.
 */
export function sortIncludeDirs(dirs: readonly string[]): readonly string[] {
  return dirs.toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * `KompileArgs.args()` (`ktool/kompile.py:589-637`) — the positional main file
 * and every backend-independent flag, in emission order.
 *
 * The order is a published semver stability promise: it changes only in a
 * major version. `kompile`'s own parser does not care, but a reordering would
 * silently invalidate every recorded argv downstream.
 */
export function kompileBaseArgs(args: KompileArgs): string[] {
  const argv: string[] = [args.mainFile];

  if (present(args.mainModule)) argv.push("--main-module", args.mainModule);
  if (present(args.syntaxModule)) argv.push("--syntax-module", args.syntaxModule);
  for (const dir of sortIncludeDirs(args.includeDirs ?? [])) argv.push("-I", dir);
  if (present(args.mdSelector)) argv.push("--md-selector", args.mdSelector);
  // One argv element, space-joined (`:604-605`).  `kompile` splits it itself.
  if ((args.hookNamespaces ?? []).length > 0) argv.push("--hook-namespaces", (args.hookNamespaces ?? []).join(" "));
  // `emit_json` defaults to True upstream (`:557`) — the opposite of the CLI.
  if (args.emitJson !== false) argv.push("--emit-json");
  if (args.genBisonParser === true) argv.push("--gen-bison-parser");
  if (args.genGlrBisonParser === true) argv.push("--gen-glr-bison-parser");
  if (args.bisonParserLibrary === true) argv.push("--bison-parser-library");
  // Unquoted, unlike `:620`.  There is no shell here to unquote it again.
  if (present(args.postProcess)) argv.push("--post-process", args.postProcess);
  if (args.readOnly === true) argv.push("--read-only-kompiled-directory");
  if (args.coverage === true) argv.push("--coverage");
  if (args.bisonLists === true) argv.push("--bison-lists");
  if (args.outerParsedJson === true) argv.push("--outer-parsed-json");
  if (present(args.topCell)) argv.push("--top-cell", args.topCell);

  return argv;
}

/** `LLVMKompile.args()` (`ktool/kompile.py:482-525`), minus the shared prefix. */
function llvmArgs(options: LLVMKompileOptions): string[] {
  const argv: string[] = [];

  if (present(options.llvmKompileType)) argv.push("--llvm-kompile-type", options.llvmKompileType);
  if (present(options.llvmKompileOutput)) argv.push("--llvm-kompile-output", options.llvmKompileOutput);

  // `opt_level or 0` then a range check (`:457-459`), then truthiness (`:492`):
  // 0 emits nothing, 1–3 emit `-O<n>`, anything else throws.
  const optLevel = options.optLevel ?? 0;
  if (!Number.isInteger(optLevel) || optLevel < 0 || optLevel > 3) {
    throw new KompileArgumentError(`Invalid optimization level: ${optLevel}`);
  }
  if (optLevel !== 0) argv.push(`-O${optLevel}`);

  for (const ccopt of options.ccopts ?? []) argv.push("-ccopt", ccopt);

  if (options.noLlvmKompile === true) argv.push("--no-llvm-kompile");
  if (options.enableSearch === true) argv.push("--enable-search");
  if (options.enableLlvmDebug === true) argv.push("--enable-llvm-debug");
  if (options.llvmProofHintInstrumentation === true) argv.push("--llvm-proof-hint-instrumentation");
  if (options.llvmProofHintDebugging === true) argv.push("--llvm-proof-hint-debugging");
  if (options.llvmHiddenVisibility === true) argv.push("--llvm-hidden-visibility");
  if (options.llvmMutableBytes === true) argv.push("--llvm-mutable-bytes");
  if (present(options.iteratedThreshold)) argv.push("--iterated-threshold", options.iteratedThreshold);
  if (present(options.heuristic)) argv.push("--heuristic", options.heuristic);

  return argv;
}

/** `HaskellKompile.args()` (`ktool/kompile.py:377-387`), minus the shared prefix. */
function haskellArgs(options: HaskellKompileOptions): string[] {
  const argv: string[] = [];
  // Comma-joined into one element (`:382`), where `-I` gets a flag per value.
  if ((options.concreteRules ?? []).length > 0) {
    argv.push("--concrete-rules", (options.concreteRules ?? []).join(","));
  }
  // Defaults to True (`:367`); only the negation has a flag.
  if (options.haskellBinary === false) argv.push("--no-haskell-binary");
  return argv;
}

/**
 * The spec's own argv: `KompileArgs.args()` followed by `--backend <b>` and the
 * backend's flags — `<Backend>Kompile.args()` (`:377`, `:402`, `:482`).
 *
 * Note the order: **the shared flags come first**, then `--backend`, then the
 * backend-specific ones.  Every upstream `args()` starts with
 * `self.base_args.args()`.
 *
 * @throws {KompileArgumentError} for an out-of-range `optLevel`.
 */
export function kompileArgs(spec: KompileSpec): string[] {
  const argv = kompileBaseArgs(spec);
  argv.push("--backend", spec.backend);
  switch (spec.backend) {
    case "llvm":
      argv.push(...llvmArgs(spec));
      break;
    case "haskell":
      argv.push(...haskellArgs(spec));
      break;
    case "maude":
      break;
  }
  return argv;
}

/**
 * The per-call options — the keyword arguments of `Kompile.__call__`
 * (`ktool/kompile.py:272-291`).
 *
 * These are not part of the spec because they are not part of *what* is being
 * compiled: the same spec run twice with different `outputDir`s is the same
 * definition.  pyk draws the line in exactly this place.
 *
 * `bug_report` is absent — both of its call sites are null-guarded upstream and
 * it is a tar-append interop format (`pyk/utils.py:696-743`) worth its own
 * module when somebody needs pyk-compatible bug reports.
 */
export interface KompileCallOptions extends ProcessControlOptions {
  /** Defaults to `['kompile']` (`:296`).  Only `command[0]` is resolved on `PATH`. */
  readonly command?: readonly string[];
  /** `--output-definition`.  Also the value {@link kompile} returns. */
  readonly outputDir?: string;
  /** `--temp-dir`. */
  readonly tempDir?: string;
  /** `--type-inference-mode`. */
  readonly typeInferenceMode?: TypeInferenceMode;
  /** `--warnings`. */
  readonly warnings?: Warnings;
  /** `--warnings-to-errors`. */
  readonly warningsToErrors?: boolean;
  /** `--no-exc-wrap`. */
  readonly noExcWrap?: boolean;
  /** `--debug`. */
  readonly debug?: boolean;
  /** `--verbose`. */
  readonly verbose?: boolean;
  /** `--outer-parsed-json`.  Suppressed if {@link KompileArgs.outerParsedJson} already emitted it. */
  readonly outerParsedJson?: boolean;
  /** `-Wno <codes>`, comma-joined into one element after the flag (`:333`). */
  readonly ignoreWarnings?: readonly string[];
  /** The child's working directory, and the base for the pre-flight path checks. */
  readonly cwd?: string;
  /** Throw {@link ProcessError} on a non-zero exit.  Defaults to `true`. */
  readonly check?: boolean;
  /** `tool_mode` (`:288`): mirror both of the child's streams onto the parent's. */
  readonly toolMode?: boolean;
  /** Where the `[PID=…]` trace goes.  Dropped by default. */
  readonly logger?: ProcessLogger;
  /**
   * The child's whole environment, replacing this process's.
   *
   * Not an upstream parameter.  It exists because `PATH` resolution should
   * agree with the environment the child will actually get — `shutil.which`
   * (`:297`) reads `os.environ` no matter what `env` the spawn is about to
   * receive, so pyk can report "found" for a `kompile` the child cannot see.
   */
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * The suffix flags of `Kompile.__call__` (`ktool/kompile.py:301-333`), in
 * emission order.
 *
 * Faithful to upstream *including* the `--outer-parsed-json` it may duplicate:
 * the de-duplication is {@link buildKompileArgv}'s job, because only the caller
 * that holds both the spec and the options can know there is a duplicate.
 */
export function kompileCallArgs(options: KompileCallOptions): string[] {
  const argv: string[] = [];

  if (present(options.outputDir)) argv.push("--output-definition", options.outputDir);
  if (present(options.tempDir)) argv.push("--temp-dir", options.tempDir);
  if (present(options.typeInferenceMode)) argv.push("--type-inference-mode", options.typeInferenceMode);
  if (present(options.warnings)) argv.push("--warnings", options.warnings);
  if (options.warningsToErrors === true) argv.push("--warnings-to-errors");
  if (options.noExcWrap === true) argv.push("--no-exc-wrap");
  if (options.debug === true) argv.push("--debug");
  if (options.verbose === true) argv.push("--verbose");
  if (options.outerParsedJson === true) argv.push("--outer-parsed-json");
  // Two elements, the codes comma-joined into the second (`:332-333`).
  if ((options.ignoreWarnings ?? []).length > 0) argv.push("-Wno", (options.ignoreWarnings ?? []).join(","));

  return argv;
}

/**
 * The complete argv: `command`, then {@link kompileArgs}, then
 * {@link kompileCallArgs} — `args = command + self.args()` and the appends that
 * follow it (`ktool/kompile.py:299-333`).
 *
 * This is where the ledger's `--outer-parsed-json` row lands: upstream can emit
 * the flag twice, once from `KompileArgs.args()` (`:631`) and once from the
 * call (`:329`).  `kompile` tolerates the repeat, so nothing was ever broken by
 * it — but an argv that differs depending on how you spelled the same request
 * is a bad golden, so the call-level flag is dropped when the spec already
 * carries it.
 */
export function buildKompileArgv(spec: KompileSpec, options: KompileCallOptions = {}): string[] {
  const command = options.command ?? ["kompile"];
  const callOptions =
    spec.outerParsedJson === true && options.outerParsedJson === true
      ? { ...options, outerParsedJson: false }
      : options;
  return [...command, ...kompileArgs(spec), ...kompileCallArgs(callOptions)];
}

//////////////////////////////
// Output directories       //
//////////////////////////////

/**
 * `_default_output_dir` (`ktool/kompile.py:356-357`): `<stem>-kompiled`, as a
 * **relative** path.
 *
 * Read that again, because it is the ledger's loudest row. The result is
 * relative to the *process* working directory — not to the main file's
 * directory, and not to `KompileCallOptions.cwd`. So
 * `kompile({backend:'llvm', mainFile:'semantics/imp.k'}, {cwd:'build'})` writes
 * to `build/imp-kompiled` (the child resolves the argv against its own cwd) but
 * *returns* `imp-kompiled`, resolved against yours.
 *
 * It is kept because downstream build scripts have been reading that string for
 * years and the compatible thing to do with a trap this old is to document it,
 * not to move it. **Pass `outputDir` explicitly** and none of this applies.
 */
export function defaultOutputDir(mainFile: string): string {
  // `Path.stem` — the basename with its last suffix removed.  `extname` agrees
  // with Python on the cases that matter, including `.hidden` (no suffix).
  const name = basename(mainFile);
  return `${name.slice(0, name.length - extname(name).length)}-kompiled`;
}

/**
 * `Kompile.default_directory` (`ktool/kompile.py:228-239`): the one
 * `*-kompiled` directory in `cwd`, with distinct errors for none and for
 * several — the `single()` contract (`pyk/utils.py:287-300`).
 *
 * Delegated to `@kframework-ts/kompiled`'s `findKompiledDir`, which is the same
 * function and already carries the messages: `KompiledDirNotFoundError` is
 * thrown with pyk's two wordings, and its `candidates` field says which case it
 * was without parsing a string.
 *
 * One divergence, from `findKompiledDir`: the returned path is joined onto
 * `cwd`, where pyk's `Path().glob` yields a bare relative name. Given the
 * {@link defaultOutputDir} trap above, a path that says where it is, is the
 * better answer.
 *
 * @throws {import('@kframework-ts/kompiled').KompiledDirNotFoundError}
 */
export function defaultDirectory(cwd: string = process.cwd()): Promise<string> {
  return findKompiledDir(cwd);
}

//////////////////////////////
// Spawning                 //
//////////////////////////////

/**
 * Compile a definition — `Kompile.__call__` (`ktool/kompile.py:272-350`).
 *
 * In order, and the order matters:
 *
 * 1. The main file must exist, and every `-I` directory must exist, both
 *    resolved with `abs_or_rel_to(…, cwd)` (`:292-294`). These are the errors
 *    worth getting before a fork.
 * 2. `command[0]` must resolve on `PATH`, else {@link KompileNotFoundError}
 *    (`:296-298`) — still no process created.
 * 3. Spawn, capturing both streams; `toolMode` also mirrors them.
 * 4. Return the output directory: `outputDir` if given, else
 *    {@link defaultOutputDir} — with the CWD-relative trap that carries.
 *
 * @returns the definition directory, which is verified to exist (pyk `assert`s
 *   it at `:348`).
 * @throws {KompileNotFoundError} when `kompile` is not on `PATH`.
 * @throws {import('./proc.js').ProcessError} when `kompile` exits non-zero and
 *   `check` is not `false`.
 * @throws {Error} when the main file or an include directory is missing, or
 *   when the run finished but the output directory did not appear.
 */
export async function kompile(spec: KompileSpec, options: KompileCallOptions = {}): Promise<string> {
  const result = await kompileDetailed(spec, options);
  await requireDefinitionDirectory(result.definitionDir, options.outputDir === undefined);
  return result.definitionDir;
}

/** The complete observable result of one `kompile` process. */
export interface KompileResult {
  /** The directory spelling `kompile()` would return. */
  readonly definitionDir: string;
  /** Whether that spelling named a directory immediately after the process. */
  readonly definitionDirExists: boolean;
  /** Exact argv, status, stdout, stderr, signal, and cancellation outcome. */
  readonly process: CompletedProcess;
}

/**
 * Compile while retaining the complete process record.
 *
 * Unlike {@link kompile}, a non-zero run under `check: false` is returned even
 * when it created no definition directory. This is the diagnostic-preserving
 * boundary for callers that need to classify K failures. Successful callers
 * should still require `definitionDirExists`; {@link kompile} does so and keeps
 * its historical return and error behavior unchanged.
 */
export async function kompileDetailed(spec: KompileSpec, options: KompileCallOptions = {}): Promise<KompileResult> {
  const base = options.cwd ?? ".";
  await checkFilePath(absOrRelTo(spec.mainFile, base));
  for (const dir of spec.includeDirs ?? []) await checkDirPath(absOrRelTo(dir, base));

  const command = options.command ?? ["kompile"];
  const executable = command[0];
  if (executable === undefined) throw new KompileArgumentError("Empty kompile command");
  // Resolved against the environment the *child* will get, which is what
  // `shutil.which` fails to do.
  if ((await resolveOnPath(executable, (options.env ?? process.env)["PATH"])) === undefined) {
    throw new KompileNotFoundError(executable);
  }

  const processResult = await runProcess(buildKompileArgv(spec, options), {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.killGraceMs === undefined ? {} : { killGraceMs: options.killGraceMs }),
    teeStdout: options.toolMode === true,
    teeStderr: options.toolMode === true,
    check: options.check !== false,
  });

  const definitionDir = options.outputDir ?? defaultOutputDir(spec.mainFile);
  return Object.freeze({
    definitionDir,
    definitionDirExists: await isDirectory(definitionDir),
    process: processResult,
  });
}

async function requireDefinitionDirectory(definitionDir: string, usedDefault: boolean): Promise<void> {
  // pyk `assert`s this (`:348`) — i.e. it vanishes under `python -O`.  A thrown
  // error is the same claim, made unconditionally.
  if (!(await isDirectory(definitionDir))) {
    throw new Error(
      `kompile reported success but ${definitionDir} is not a directory. ` +
        (usedDefault
          ? "The default output directory is resolved against this process's working directory, not `cwd` — pass `outputDir` explicitly."
          : ""),
    );
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

//////////////////////////////
// Booster                  //
//////////////////////////////

/**
 * Every key a booster spec may carry: the shared ones plus **both** backends'.
 *
 * There is no discriminant, because the point is that one description feeds two
 * kompilations.
 */
export interface BoosterKompileSpec extends KompileArgs, LLVMKompileOptions, HaskellKompileOptions {}

/**
 * `_booster_kompile` (`ktool/kompile.py:109-182`): two kompilations of one
 * definition, run concurrently.
 *
 * The LLVM half is forced to `llvmKompileType: 'c'` and lands in
 * `<outputDir>/llvm-library`; the Haskell half lands in `<outputDir>`. That
 * pairing is what the "booster" execution mode is: the Haskell backend does the
 * reasoning and calls into the LLVM library for concrete steps.
 *
 * Concurrency is `Promise.all` where pyk uses a two-worker
 * `ThreadPoolExecutor` — same shape, and unlike the Python version there is no
 * GIL to make "concurrent" mean "interleaved".
 *
 * **The one divergence: unknown keys throw.** `_group_args` (`:185-198`) walks
 * the dict and copies each key into whichever bucket claims it — and *silently
 * drops* any key neither bucket does. So `_booster_kompile` accepts a
 * misspelled option, ignores it, and produces a definition built without it.
 * The type system already prevents this for a literal; the runtime check
 * catches the dynamic caller, which is exactly the caller pyk fails.
 *
 * @throws {KompileArgumentError} for an unknown key, or for an
 *   `llvmKompileType` other than `'c'` (`:128-129`).
 */
export async function boosterKompile(spec: BoosterKompileSpec, options: KompileCallOptions = {}): Promise<string> {
  if (spec.llvmKompileType !== undefined && spec.llvmKompileType !== "c") {
    throw new KompileArgumentError(
      `Unsupported argument value for Booster kompilation: llvmKompileType: ${spec.llvmKompileType}`,
    );
  }

  const { common, llvm, haskell } = groupArgs(spec);

  const outputDir = options.outputDir ?? defaultOutputDir(spec.mainFile);
  const llvmOptions: KompileCallOptions = {
    ...options,
    outputDir: join(outputDir, LLVM_LIBRARY_DIR),
    ...(present(options.tempDir) ? { tempDir: join(options.tempDir, LLVM_LIBRARY_DIR) } : {}),
  };

  await Promise.all([
    kompile({ ...common, ...llvm, backend: "llvm", llvmKompileType: "c" }, llvmOptions),
    kompile({ ...common, ...haskell, backend: "haskell" }, { ...options, outputDir }),
  ]);

  return outputDir;
}

/**
 * `_group_args` (`ktool/kompile.py:185-198`), with the silent drop replaced by
 * a throw.
 *
 * Returns three buckets rather than two so the shared keys are copied once; the
 * observable result is the same pair upstream builds.
 */
function groupArgs(spec: BoosterKompileSpec): {
  readonly common: KompileArgs;
  readonly llvm: LLVMKompileOptions;
  readonly haskell: HaskellKompileOptions;
} {
  const common: Record<string, unknown> = {};
  const llvm: Record<string, unknown> = {};
  const haskell: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(spec)) {
    if (value === undefined) continue;
    if ((COMMON_ARG_KEYS as readonly string[]).includes(key)) common[key] = value;
    else if ((LLVM_ARG_KEYS as readonly string[]).includes(key)) llvm[key] = value;
    else if ((HASKELL_ARG_KEYS as readonly string[]).includes(key)) haskell[key] = value;
    else throw new KompileArgumentError(`Unexpected argument for Booster kompilation: ${key}`);
  }

  // The buckets were filled from keys checked against the same inventories the
  // three interfaces are declared from, so this narrowing is a restatement of
  // the loop above rather than a new claim.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return { common, llvm, haskell } as unknown as {
    readonly common: KompileArgs;
    readonly llvm: LLVMKompileOptions;
    readonly haskell: HaskellKompileOptions;
  };
}

//////////////////////////////
// The dynamic door         //
//////////////////////////////

/**
 * `Kompile.from_dict` (`ktool/kompile.py:241-266`): build a {@link KompileSpec}
 * from an untyped record, **raising on any key the chosen backend does not
 * claim**.
 *
 * For callers that do not have a literal to hand — a build plugin reading a
 * manifest, a CLI assembling flags. A caller who *does* have a literal should
 * write the {@link KompileSpec} and let the compiler check it.
 *
 * Upstream's three rules, kept exactly:
 *
 * - **The backend defaults to `llvm`** (`:243`), including when `backend` is
 *   present but nullish — `dct.get('backend') or 'llvm'`.
 * - An unrecognised key raises, naming the backend and the key (`:255`).
 * - `kore` is rejected (`:265-266`), even though `KompileBackend` has it: there
 *   is no `KoreKompile` class to build.
 *
 * Added on top: the values are **type-checked**. pyk's dataclasses accept
 * anything and fail later — at `str.join` inside `args()`, or not at all, with
 * a number silently becoming a flag value. A dynamic entry point that will not
 * tell you which key was wrong is not much of an entry point.
 *
 * @throws {KompileArgumentError} for an unknown backend, an unknown key, or a
 *   value of the wrong type.
 */
export function kompileFromDict(dict: Readonly<Record<string, unknown>>): KompileSpec {
  const rawBackend = dict["backend"];
  // `dct.get('backend') or 'llvm'` (`:243`): absent, `None` and `''` all default.
  const backend = rawBackend === undefined || rawBackend === null || rawBackend === "" ? "llvm" : rawBackend;
  if (!isKompileBackend(backend)) throw new KompileArgumentError(`Unsupported backend: ${JSON.stringify(backend)}`);
  // `KompileBackend` has `kore`, and `from_dict`'s match has no arm for it
  // (`:265-266`), so a kore spec has never been constructible.
  if (backend === "kore") throw new KompileArgumentError("Unsupported backend: kore");

  const backendKeys = backendArgKeys(backend);
  const spec: Record<string, unknown> = { backend };
  for (const [key, value] of Object.entries(dict)) {
    if (key === "backend") continue;
    if (!(COMMON_ARG_KEYS as readonly string[]).includes(key) && !backendKeys.includes(key)) {
      throw new KompileArgumentError(`Unexpected argument for backend: ${backend}: ${key}=${JSON.stringify(value)}`);
    }
    spec[key] = coerce(key, value);
  }

  if (typeof spec["mainFile"] !== "string") {
    throw new KompileArgumentError("Missing required argument: mainFile");
  }

  // Every key was checked against the inventories the union is declared from,
  // and every value against that key's type, so the union membership holds.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return spec as unknown as KompileSpec;
}

/** Which of the four shapes each key's value must have. */
const STRING_KEYS = new Set([
  "mainFile",
  "mainModule",
  "syntaxModule",
  "mdSelector",
  "postProcess",
  "topCell",
  "llvmKompileType",
  "llvmKompileOutput",
  "iteratedThreshold",
  "heuristic",
]);
const STRING_ARRAY_KEYS = new Set(["includeDirs", "hookNamespaces", "ccopts", "concreteRules"]);
const NUMBER_KEYS = new Set(["optLevel"]);

function coerce(key: string, value: unknown): unknown {
  if (STRING_KEYS.has(key)) {
    if (typeof value !== "string")
      throw new KompileArgumentError(`Expected a string for ${key}, found ${typeName(value)}`);
    if (key === "llvmKompileType" && !(LLVM_KOMPILE_TYPES as readonly string[]).includes(value)) {
      throw new KompileArgumentError(`Unknown llvmKompileType: ${value}`);
    }
    return value;
  }
  if (STRING_ARRAY_KEYS.has(key)) {
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
      throw new KompileArgumentError(`Expected an array of strings for ${key}, found ${typeName(value)}`);
    }
    return value;
  }
  if (NUMBER_KEYS.has(key)) {
    if (typeof value !== "number")
      throw new KompileArgumentError(`Expected a number for ${key}, found ${typeName(value)}`);
    return value;
  }
  // Everything else in the inventories is a flag.
  if (typeof value !== "boolean")
    throw new KompileArgumentError(`Expected a boolean for ${key}, found ${typeName(value)}`);
  return value;
}

function typeName(value: unknown): string {
  if (value === null) return "null";
  return Array.isArray(value) ? "an array" : typeof value;
}
