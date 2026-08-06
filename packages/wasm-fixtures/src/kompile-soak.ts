/**
 * Build the **complete** KWasm kompiled directory the soak suites opt into, once
 * per machine, into a content-keyed cache outside anybody's checkout.
 *
 * ```sh
 * KFRAMEWORK_TS_K_BIN=/nix/store/…-k-7.1.337-…/bin \
 * KFRAMEWORK_TS_RV_CHECKOUTS=…/inspirations/runtimeverification \
 *   bun run --cwd packages/wasm-fixtures kompile-soak
 * ```
 *
 * It prints the directory it built (or found), and after that
 * {@link wasmSoakDir} finds the same one with no variable exported at all — so
 * `bun test` from anywhere in the workspace picks the soak up.  Twenty-one
 * seconds and 3.1 GB of peak RSS, once.
 *
 * ## Why this is transcribed rather than imported
 *
 * The content-keyed staleness check and the write-marker-then-atomically-rename
 * idiom below are `@kframework-ts/ktool`'s (`src/testing.ts:136-297`), and they
 * are copied rather than called.  Importing them would give this package a
 * dependency on `ktool`, and `ktool`'s own test fixtures come from
 * `@kframework-ts/kompiled` — which takes *this* package as a dev dependency.
 * That is the cycle `kompiled → wasm-fixtures → ktool → kompiled`, and this
 * workspace has none.  Ninety lines of duplication is the cheaper of the two.
 *
 * The same transcription is why nothing here spawns through `ktool`'s
 * `buildKompileArgv`: the recipe is a fixed, pinned argv
 * ({@link WASM_KOMPILE_ARGV}), not a spec to be built.
 *
 * See `docs/gap-analysis.md` §S1 (`kdist`), which names content-keyed
 * up-to-date checks and per-target build locks as the two ideas worth stealing
 * from upstream's distribution layer.  The first is stolen here; the second is
 * not — a second concurrent `kompile-soak` wastes twenty-one seconds and then
 * loses the rename race harmlessly, which is a better trade than a lock file
 * this workspace would have to reason about.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";

import {
  isCompletedCacheEntry,
  K_BIN_ENV,
  RV_CHECKOUTS_ENV,
  WASM_CACHE_MARKER,
  WASM_CACHE_SCHEMA,
  WASM_KOMPILE_ARGV,
  WASM_PIN,
  WASM_SEMANTICS_DIR_NAME,
  WASM_SEMANTICS_SRC_SUBDIR,
  envDir,
  wasmCacheKey,
  wasmCacheRoot,
  wasmKompileArgv,
} from "./index.js";

/** One parsed command line. Every field has an environment fallback but `force`. */
export interface SoakOptions {
  /** K's `bin` directory or its `kompile` executable; defaults to {@link K_BIN_ENV}, then `PATH`. */
  readonly kBin: string | undefined;
  /** The `wasm-semantics` checkout; defaults to `$KFRAMEWORK_TS_RV_CHECKOUTS/wasm-semantics`. */
  readonly checkout: string | undefined;
  /** Cache root; defaults to {@link wasmCacheRoot}. */
  readonly cacheDir: string | undefined;
  /** The exact `kompile --version` required; defaults to {@link WasmPin.kBuiltWith}. */
  readonly kVersion: string | undefined;
  /** Rebuild even on a cache hit. */
  readonly force: boolean;
  /** Downgrade a checkout-at-the-wrong-commit failure to a warning. */
  readonly allowCommitMismatch: boolean;
  /** Print usage and do nothing. */
  readonly help: boolean;
}

/** A command line this script will not act on. */
export class SoakUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SoakUsageError";
  }
}

const USAGE = `kompile-soak — build the complete KWasm kompiled directory into a content-keyed cache

  bun run --cwd packages/wasm-fixtures kompile-soak [options]

  --k-bin <dir>            K's bin directory or its kompile (default: $${K_BIN_ENV}, then PATH)
  --checkout <dir>         a wasm-semantics checkout (default: $${RV_CHECKOUTS_ENV}/${WASM_SEMANTICS_DIR_NAME})
  --cache <dir>            cache root (default: $KFRAMEWORK_TS_KOMPILE_CACHE, then the user cache)
  --k-version <version>    the exact kompile --version required (default: ${WASM_PIN.kBuiltWith})
  --force                  rebuild over an existing cache entry
  --allow-commit-mismatch  warn instead of failing when the checkout is off the pin
  -h, --help               this text

Prints the directory it built or found.  wasmSoakDir() then discovers it with no
environment variable set, so a plain \`bun test\` runs the soak suites.
`;

/**
 * Parse the argv this script accepts.
 *
 * Pure, and exported so `test/kompile-soak.test.ts` can check it without a K
 * install: every other line in this file needs a toolchain.
 */
export function parseSoakArgs(argv: readonly string[]): SoakOptions {
  let kBin: string | undefined;
  let checkout: string | undefined;
  let cacheDir: string | undefined;
  let kVersion: string | undefined;
  let force = false;
  let allowCommitMismatch = false;
  let help = false;

  const value = (index: number, flag: string): string => {
    const next = argv[index];
    if (next === undefined || next.startsWith("--")) throw new SoakUsageError(`${flag} needs a value`);
    return next;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    switch (flag) {
      case "--k-bin":
        kBin = value((index += 1), flag);
        break;
      case "--checkout":
        checkout = value((index += 1), flag);
        break;
      case "--cache":
        cacheDir = value((index += 1), flag);
        break;
      case "--k-version":
        kVersion = value((index += 1), flag);
        break;
      case "--force":
        force = true;
        break;
      case "--allow-commit-mismatch":
        allowCommitMismatch = true;
        break;
      case "-h":
      case "--help":
        help = true;
        break;
      default:
        throw new SoakUsageError(`Unknown argument: ${flag}`);
    }
  }

  return { kBin, checkout, cacheDir, kVersion, force, allowCommitMismatch, help };
}

/** Everything this script writes goes through one of these two sinks. */
export type Write = (text: string) => void;

/**
 * Run the builder. Returns a process exit code and never throws for an expected
 * failure — a missing toolchain, a checkout off the pin, a `kompile` that exits
 * non-zero — each of which gets a message naming the fix.
 */
export function main(argv: readonly string[], out: Write, err: Write): number {
  let options: SoakOptions;
  try {
    options = parseSoakArgs(argv);
  } catch (error) {
    err(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    out(USAGE);
    return 0;
  }

  const expectedVersion = options.kVersion ?? WASM_PIN.kBuiltWith;

  const kompilePath = resolveKompile(options.kBin);
  if (kompilePath === undefined) {
    err(
      `No kompile found.  Set ${K_BIN_ENV} to K's bin directory (or pass --k-bin), ` +
        `or put kompile on PATH.  This build needs K ${expectedVersion}.\n`,
    );
    return 1;
  }

  const version = kompileVersion(kompilePath);
  if (version === undefined) {
    err(`Could not read a version from \`${kompilePath} --version\`.\n`);
    return 1;
  }
  if (version !== expectedVersion) {
    err(
      `K version mismatch: ${kompilePath} is ${version}, and this recipe is pinned to ${expectedVersion}.\n` +
        `A directory built by another release will not match the vendored definition hash, so the soak ` +
        `suites would reject it anyway.  Pass --k-version ${version} to build (and key) against this one.\n`,
    );
    return 1;
  }

  const checkout = options.checkout ?? defaultCheckout();
  if (checkout === undefined) {
    err(
      `No wasm-semantics checkout.  Set ${RV_CHECKOUTS_ENV} to a directory holding ` +
        `${WASM_SEMANTICS_DIR_NAME}/ (or pass --checkout).\n`,
    );
    return 1;
  }
  const src = join(absolute(checkout), WASM_SEMANTICS_SRC_SUBDIR);
  if (!isDirectory(src)) {
    err(`Not a wasm-semantics checkout: ${checkout} has no ${WASM_SEMANTICS_SRC_SUBDIR}/.\n`);
    return 1;
  }

  const head = gitHead(absolute(checkout));
  if (head !== WASM_PIN.commit) {
    const found = head ?? "unknown (not a git checkout?)";
    const message =
      `${checkout} is at ${found}, and the pin is ${WASM_PIN.commit} (${WASM_PIN.tag}).\n` +
      `A build off the pin will not match WASM_DEFINITION_HASH, so the soak suites will reject it.\n`;
    if (!options.allowCommitMismatch) {
      err(`${message}Pass --allow-commit-mismatch to build anyway.\n`);
      return 1;
    }
    err(`warning: ${message}`);
  }

  const key = wasmCacheKey(expectedVersion);
  const soakRoot = join(options.cacheDir === undefined ? wasmCacheRoot() : absolute(options.cacheDir), "wasm-soak");
  const entry = join(soakRoot, key);

  if (isCompletedCacheEntry(entry, key) && !options.force) {
    err("cache hit; pass --force to rebuild\n");
    out(`${entry}\n`);
    return 0;
  }
  // An entry that exists but has no valid marker is the wreckage of an
  // interrupted build, and `--force` is an instruction to replace a good one:
  // both are removed rather than compiled over, because `kompile -o` into a
  // populated directory is not defined to produce a clean result.
  rmSync(entry, { recursive: true, force: true });

  const staging = join(soakRoot, `.${key}-${process.pid}-${Date.now()}`);
  mkdirSync(soakRoot, { recursive: true });
  try {
    const argvForKompile = [...wasmKompileArgv(src), "-o", staging];
    err(`${kompilePath} ${argvForKompile.join(" ")}\n`);
    const built = spawnSync(kompilePath, argvForKompile, { stdio: ["ignore", "inherit", "inherit"] });
    if (built.error !== undefined) throw built.error;
    if (built.status !== 0) {
      err(`kompile exited ${built.status ?? "on a signal"}\n`);
      rmSync(staging, { recursive: true, force: true });
      return 1;
    }
    // The marker is written last and the whole directory is then renamed into
    // place, so a killed build leaves either nothing or a directory that
    // `isCompletedCacheEntry` refuses — never a half-built cache hit.
    writeFileSync(
      join(staging, WASM_CACHE_MARKER),
      `${JSON.stringify({
        schema: WASM_CACHE_SCHEMA,
        key,
        k: expectedVersion,
        pin: WASM_PIN.commit,
        argv: WASM_KOMPILE_ARGV,
        builtAt: new Date().toISOString(),
      })}\n`,
    );
    renameSync(staging, entry);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    err(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  out(`${entry}\n`);
  return 0;
}

function resolveKompile(configured: string | undefined): string | undefined {
  const fromFlag = configured ?? envDir(K_BIN_ENV);
  if (fromFlag !== undefined) {
    const path = basename(fromFlag) === "kompile" ? absolute(fromFlag) : join(absolute(fromFlag), "kompile");
    return existsSync(path) ? path : undefined;
  }
  // No variable, no flag: fall back to `PATH`, which `spawnSync` resolves for a
  // bare name.  Probing with `--version` is the cheapest way to find out
  // whether that name exists at all.
  return kompileVersion("kompile") === undefined ? undefined : "kompile";
}

function kompileVersion(kompilePath: string): string | undefined {
  const probe = spawnSync(kompilePath, ["--version"], { encoding: "utf8" });
  if (probe.error !== undefined || probe.status !== 0) return undefined;
  // `K version:    v7.1.337` — the leading `v` is dropped so this compares
  // against the release as `WASM_PIN` and `fixtures/PROVENANCE.md` spell it.
  const match = /^K version:\s*v?(?<version>\S+)$/mu.exec(probe.stdout ?? "");
  return match?.groups?.["version"];
}

function defaultCheckout(): string | undefined {
  const root = envDir(RV_CHECKOUTS_ENV);
  return root === undefined ? undefined : join(absolute(root), WASM_SEMANTICS_DIR_NAME);
}

function gitHead(checkout: string): string | undefined {
  const probe = spawnSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" });
  if (probe.error !== undefined || probe.status !== 0) return undefined;
  return (probe.stdout ?? "").trim() || undefined;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function absolute(path: string): string {
  return isAbsolute(path) ? path : resolve(path);
}
