/**
 * Finding K on the machine, and asking it what version it is —
 * `KDistribution` (`pyk/ktool/utils.py`) and `k_version`/`KVersion`
 * (`pyk/kbuild/utils.py:18-79`).
 *
 * # Two things pyk does here that this package does not
 *
 * 1. **`which kompile` as a subprocess** (`ktool/utils.py:36-44`).  A `which`
 *    binary is not guaranteed to exist, its output format is not specified, and
 *    forking to answer a question about `PATH` is a question you already have
 *    the answer to.  {@link resolveOnPath} walks `PATH` in-process instead.
 * 2. **`K_DISTRIBUTION` evaluated at import time** (`ktool/utils.py:47`).
 *    `import pyk.ktool.utils` forks a process.  {@link getKDistribution} is
 *    lazy and memoised: nothing happens until somebody asks, and the answer is
 *    computed once.
 *
 * The *layout* assumption is pyk's and is kept: the install prefix is the
 * `kompile` binary's grandparent (`kompile_bin.parents[1]`), i.e. `bin/kompile`
 * sits under it, and `include/kframework/builtin` is where `domains.md` and the
 * rest of K's prelude live — the directory `-I` needs and the one
 * `ClaimLoader`'s digest is computed over.  Note that pyk resolves *no*
 * symlinks doing this, so a `kompile` symlinked into `~/.local/bin` reports
 * `~/.local` as the prefix; that is upstream's behaviour and this reproduces
 * it, because "fixing" it would silently change which builtins a build sees.
 */

import { access, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { z } from "zod";

import { runProcess, type ProcessControlOptions, type ProcessLogger } from "./proc.js";

//////////////////////////////
// PATH resolution          //
//////////////////////////////

/**
 * The first entry of `path` that holds an executable file named `name` —
 * `shutil.which` with none of its Windows machinery.
 *
 * A `name` that already contains a separator is **not** searched for: that is
 * `shutil.which`'s rule too, and it is what lets a caller pass
 * `./build/kompile` and have it mean what it says.
 *
 * `path` defaults to `process.env.PATH`.  Passing `""` searches nowhere, which
 * is the cheap way to prove a caller checks before it spawns.
 *
 * **POSIX only, deliberately.**  The executable test is `access(X_OK)`, which
 * on Windows reports every existing file as executable, and no `PATHEXT`
 * suffixes are tried, so `kompile.exe` will not be found by the name `kompile`.
 * K's own distribution is POSIX (WSL included); a Windows story belongs with
 * the rest of the Windows work (`interpreter.ts`'s `/dev/*` literals first),
 * not smuggled in here untested.
 */
export async function resolveOnPath(
  name: string,
  path: string | undefined = process.env["PATH"],
): Promise<string | undefined> {
  if (name === "") return undefined;
  if (name.includes("/") || name.includes("\\")) return (await isExecutableFile(name)) ? name : undefined;

  for (const entry of (path ?? "").split(delimiter)) {
    // An empty `PATH` entry means the current directory to a POSIX shell.  It
    // does *not* to `shutil.which`, which skips it, and a tool that silently
    // ran `./kompile` because of a stray colon would be a security problem.
    if (entry === "") continue;
    const candidate = join(entry, name);
    if (await isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

//////////////////////////////
// The distribution         //
//////////////////////////////

/** Where K is installed — pyk's `KDistribution` (`ktool/utils.py:14-44`). */
export interface KDistribution {
  /** The install prefix: the `kompile` binary's grandparent (`ktool/utils.py:34`). */
  readonly path: string;
  /** `<path>/bin` — the directory `kompile` itself was found in. */
  readonly binDir: string;
  /** `<path>/include/kframework/builtin` — `KDistribution.builtin_dir` (`:25-27`). */
  readonly builtinDir: string;
}

/** Assemble the three paths from the resolved `kompile` binary.  Pure. */
export function kDistributionFrom(kompileBin: string): KDistribution {
  const binDir = dirname(kompileBin);
  const path = dirname(binDir);
  return Object.freeze({ path, binDir, builtinDir: join(path, "include", "kframework", "builtin") });
}

let cached: Promise<KDistribution | undefined> | undefined;

/**
 * The installed K distribution, or `undefined` if `kompile` is not on `PATH`.
 *
 * Lazy and memoised — including the negative answer, which is the same
 * memoisation pyk gets for free from a module-level constant.  Nothing here
 * throws: "K is not installed" is an answer, and the caller decides whether it
 * is an error (`kompile()` turns it into `KompileNotFoundError`; a `-I` default
 * would rather fall back).
 *
 * The memo is keyed on nothing, so a `PATH` that changes mid-process is not
 * noticed.  {@link clearKDistributionCache} exists for the one caller that
 * needs that — a test — and for a long-lived process that installs K underneath
 * itself.
 */
export async function getKDistribution(): Promise<KDistribution | undefined> {
  cached ??= (async () => {
    const bin = await resolveOnPath("kompile");
    return bin === undefined ? undefined : kDistributionFrom(bin);
  })();
  return cached;
}

/** Forget what {@link getKDistribution} memoised. */
export function clearKDistributionCache(): void {
  cached = undefined;
}

//////////////////////////////
// Version                  //
//////////////////////////////

/** The `-<ahead>-g<rev>[-dirty]` tail of a `git describe` version. */
/** The `git describe` component of a K version. */
export const KVersionGitSchema = z.object({
  ahead: z.number().int(),
  rev: z.string().regex(/^[0-9a-f]{10}$/u),
  dirty: z.boolean(),
});

export type KVersionGit = z.infer<typeof KVersionGitSchema>;

/** A parsed K version — pyk's `KVersion` (`kbuild/utils.py:18-66`). */
export interface KVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** Absent for a released build; present when K was built off a tag. */
  readonly git: KVersionGit | undefined;
  /** The canonical spelling, round-tripping {@link parseKVersion}. */
  readonly text: string;
}

const KVersionInputSchema = z.object({
  major: z.number().int(),
  minor: z.number().int(),
  patch: z.number().int(),
  /** Absent for a released build; present when K was built off a tag. */
  git: z.union([KVersionGitSchema, z.undefined()]),
  /** The canonical spelling, round-tripping {@link parseKVersion}. */
  text: z.string(),
});

/** Structural K version record. Text/component agreement remains parser semantics. */
export const KVersionSchema: z.ZodType<KVersion, z.input<typeof KVersionInputSchema>> = KVersionInputSchema.superRefine(
  (version, context) => {
    if (!Object.hasOwn(version, "git"))
      context.addIssue({ code: "custom", message: "git must be present, even when undefined" });
  },
).transform(
  (version): KVersion => ({
    major: version.major,
    minor: version.minor,
    patch: version.patch,
    git: version.git,
    text: version.text,
  }),
);

/** A strict parse result that preserves an unrecognised observed spelling. */
export const KVersionParseResultSchema = z.union([
  z.object({ kind: z.literal("parsed"), version: KVersionSchema }),
  z.object({ kind: z.literal("unrecognized"), text: z.string() }),
]);

export type KVersionParseResult = z.infer<typeof KVersionParseResultSchema>;

/** A parsed version together with the exact bytes `kompile --version` emitted. */
export interface KVersionResult extends KVersion {
  /** The complete, unmodified stdout banner. */
  readonly banner: string;
  /** The unmodified first line of the banner. */
  readonly line: string;
}

const KVersionResultInputSchema = KVersionInputSchema.extend({
  /** The complete, unmodified stdout banner. */
  banner: z.string(),
  /** The unmodified first line of the banner. */
  line: z.string(),
});

/** Structural `kompile --version` evidence; banner/line interpretation remains in `kVersion`. */
export const KVersionResultSchema: z.ZodType<
  KVersionResult,
  z.input<typeof KVersionResultInputSchema>
> = KVersionResultInputSchema.superRefine((version, context) => {
  if (!Object.hasOwn(version, "git"))
    context.addIssue({ code: "custom", message: "git must be present, even when undefined" });
}).transform(
  (version): KVersionResult => ({
    major: version.major,
    minor: version.minor,
    patch: version.patch,
    git: version.git,
    text: version.text,
    banner: version.banner,
    line: version.line,
  }),
);

/**
 * `KVersion.PATTERN` (`kbuild/utils.py:38-47`), with one character changed.
 *
 * Upstream writes the major component as `[1-9]+`, which accepts `7` and `99`
 * and **rejects `10`** — the digit `0` is not in the class.  K has not reached
 * major 10, so the bug has never fired; this uses `0|[1-9][0-9]*` instead, which
 * accepts every major upstream accepts, plus `10` and up, and still rejects a
 * leading zero.  Everything else — the ten-hex-digit `rev`, `-dirty` being
 * legal only *inside* the git group, the whole-string match — is verbatim.
 */
const K_VERSION_PATTERN =
  /^v(?<major>0|[1-9][0-9]*)\.(?<minor>[0-9]+)\.(?<patch>[0-9]+)(?<git>-(?<ahead>[0-9]+)-g(?<rev>[0-9a-f]{10})(?<dirty>-dirty)?)?$/u;

/** A string is not a K version.  Python raises `ValueError`; the message is pyk's. */
export class KVersionParseError extends Error {
  /** The text that did not parse. */
  readonly text: string;

  constructor(text: string) {
    super(`Invalid K version string: ${text}`);
    this.name = "KVersionParseError";
    this.text = text;
  }
}

/**
 * Parse `vMAJOR.MINOR.PATCH[-N-g<10 hex>][-dirty]` — `KVersion.parse`
 * (`kbuild/utils.py:49-58`).
 *
 * Note that `-dirty` alone is **not** a version: upstream's `dirty` group lives
 * inside the `git` group, so `v7.1.337-dirty` fails to match and this throws.
 * That is not an oversight to fix — `git describe --dirty` never emits the
 * suffix without a commit count, so a string in that shape came from somewhere
 * else and should not be silently accepted.
 *
 * @throws {KVersionParseError}
 */
export function parseKVersion(text: string): KVersion {
  const match = K_VERSION_PATTERN.exec(text);
  const groups = match?.groups;
  if (groups === undefined) throw new KVersionParseError(text);

  const major = Number(groups["major"]);
  const minor = Number(groups["minor"]);
  const patch = Number(groups["patch"]);
  const git =
    groups["git"] === undefined
      ? undefined
      : Object.freeze({
          ahead: Number(groups["ahead"]),
          rev: groups["rev"] ?? "",
          dirty: groups["dirty"] !== undefined,
        });

  return Object.freeze({ major, minor, patch, git, text: formatKVersion(major, minor, patch, git) });
}

/**
 * Parse a K version when possible, otherwise preserve its observed spelling.
 *
 * Unlike {@link parseKVersion}, this never throws and does not broaden the
 * strict grammar. It is for toolchain fingerprints that must survive an
 * unfamiliar local build banner.
 */
export function tryParseKVersion(text: string): KVersionParseResult {
  try {
    return Object.freeze({ kind: "parsed" as const, version: parseKVersion(text) });
  } catch (error) {
    if (!(error instanceof KVersionParseError)) throw error;
    return Object.freeze({ kind: "unrecognized" as const, text });
  }
}

/** `KVersion.text` (`kbuild/utils.py:60-66`) — the spelling `parse` accepts back. */
function formatKVersion(major: number, minor: number, patch: number, git: KVersionGit | undefined): string {
  const base = `v${major}.${minor}.${patch}`;
  if (git === undefined) return base;
  return `${base}-${git.ahead}-g${git.rev}${git.dirty ? "-dirty" : ""}`;
}

/**
 * The label `kompile --version` puts in front of the version on its first line.
 *
 * pyk slices the first line at **column 14** (`kbuild/utils.py:76`), which is
 * `len('K version:') + 4` and works only because the padding is exactly four
 * spaces.  Stripping the label by pattern accepts everything that slice accepts
 * and survives a change in the padding, which is the sort of change nobody
 * would think to announce.
 */
const K_VERSION_LABEL = /^K\s+version:\s*/u;

/**
 * Run `kompile --version` and parse its first line — `k_version`
 * (`kbuild/utils.py:69-79`).
 *
 * `command` defaults to `['kompile']` and is resolved by the OS, not by
 * {@link resolveOnPath}: pyk lets the `FileNotFoundError` out and turns it into
 * `RuntimeError('K is not installed')`, and there is nothing better to do with
 * it here either.
 *
 * @throws {KVersionParseError} when the first line does not carry a version.
 * @throws {ProcessError} when `kompile` exits non-zero.
 */
export async function kVersion(
  command: readonly string[] = ["kompile"],
  options: {
    readonly cwd?: string;
    readonly logger?: ProcessLogger;
    readonly env?: Readonly<Record<string, string>>;
  } & ProcessControlOptions = {},
): Promise<KVersionResult> {
  const result = await runProcess([...command, "--version"], options);
  const firstLine = result.stdout.split("\n")[0] ?? "";
  return Object.freeze({
    ...parseKVersion(firstLine.replace(K_VERSION_LABEL, "").trim()),
    banner: result.stdout,
    line: firstLine,
  });
}
