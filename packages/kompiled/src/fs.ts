/**
 * The I/O shell — the **only** file in this monorepo that reads a disk.
 *
 * Every other package here is a pure function of strings, and that property is
 * worth keeping: `packages/kast/src/outer.ts:1842` carries a comment explaining
 * why `readKastDefinition` takes a parsed value rather than a path.  This
 * package has to break the rule, so it breaks it in one file, in about a
 * hundred lines, behind three functions.  `layout.ts` and `kompiled.ts` stay
 * testable — and usable over a virtual filesystem, a zip, or an HTTP range
 * reader — without any of this.
 *
 * # Why both `node:fs/promises` and `node:fs`
 *
 * The marker files are small, always present, and read up front: `promises` is
 * the right API for them, and {@link loadKompiledDefinition} is `async` because
 * of them.
 *
 * The four big artifacts are read **lazily, from a getter** — `definition` is a
 * property, not a method returning a `Promise`, because that is what makes it
 * read like pyk's `KPrint.definition` and what lets a caller touch it without
 * restructuring around `await`.  A synchronous getter needs a synchronous read,
 * so {@link KompiledSource.read} is backed by `readFileSync`.  The alternative —
 * reading all four eagerly during `load` — is exactly the thing that would make
 * the package unusable on real semantics: `definition.kore` alone is 71 MB for
 * Foundry.
 *
 * # Nothing is ever written
 *
 * pyk writes a `pyk-definition.kore.json` cache into the directory it read
 * (`kore/kompiled.py:103`) and an import graph beside it (`__main__.py:393`),
 * which is why `kompile` grew `--read-only-kompiled-directory`
 * (`ktool/kompile.py:622`) to stop it.  This package has no write path at all.
 * If it ever caches, the cache goes somewhere of our choosing under our own
 * name.
 */

import { readFileSync } from "node:fs";
import { readdir, readFile, readlink as readLink, stat } from "node:fs/promises";
import { join } from "node:path";
import { KompiledDirNotFoundError, MissingKompiledFileError } from "./errors.js";
import { KompiledDefinition, type KompiledArtifact, type KompiledDefinitionOptions } from "./kompiled.js";
import { parseKompiledLayout, type KompiledLayout } from "./layout.js";
import {
  expectedBisonParserArtifacts,
  type ExpectedBisonParser,
  type ExpectedBisonParserAlias,
} from "./parser-artifacts.js";

/**
 * The nested directory a **booster** kompilation puts its LLVM half in.
 *
 * `pyk`'s booster backend runs `kompile` twice: haskell at the top level and
 * llvm into `<dir>/llvm-library` (`ktool/kompile.py:109-176`), which
 * `kore/rpc.py:1481-1494` then validates.  It is a complete kompiled directory
 * in its own right, so it loads with the same functions:
 * `loadKompiledLayout(join(dir, LLVM_LIBRARY_DIR))`.
 *
 * This is also the clearest evidence that **directory naming is not a
 * contract**: `llvm-library` does not end in `-kompiled`, and neither does
 * anything passed to `kompile -o`.  {@link findKompiledDir} is a convenience for
 * the default case, never an assumption.
 */
export const LLVM_LIBRARY_DIR = "llvm-library";

/**
 * The marker files that must exist.  Each backs one pyk `DefinitionInfo`
 * property: `main_module_name`, `syntax_module_name`, `backend`, `timestamp`.
 */
export const REQUIRED_MARKERS = ["mainModule.txt", "mainSyntaxModule.txt", "backend.txt", "timestamp"] as const;

/** The three markers whose *contents* are read.  `timestamp` is only `stat`ed. */
const TEXT_MARKERS = ["mainModule.txt", "mainSyntaxModule.txt", "backend.txt"] as const;

/**
 * Read the cheap half of a kompiled directory — pyk's `DefinitionInfo`
 * (`ktool/kompile.py:643-668`) plus `allRules.txt` and `configVars.sh`.
 *
 * The four files in {@link REQUIRED_MARKERS} are the "always present" set and
 * their absence throws; `allRules.txt` and
 * `configVars.sh` default to empty.
 *
 * `timestamp` is `stat`ed and never opened.  Its seven bytes are a
 * Java-serialized empty string, and it is written **last**
 * (`KompileFrontEnd.java:116`), which is the only reason its mtime means
 * anything — it post-dates every other artifact in the directory, so `make`
 * can use it and so can you.
 *
 * @throws {MissingKompiledFileError} when a required marker is absent, naming
 *   the file and the directory.  When several are absent — a directory that
 *   does not exist at all, say — the error names the **first** in
 *   {@link REQUIRED_MARKERS} order.  That is why the reads are gathered with
 *   `allSettled` and not `all`: `Promise.all` rejects with whichever read loses
 *   the race, so the reported file would differ between runs on exactly the
 *   inputs where it matters most.
 */
export async function loadKompiledLayout(dir: string): Promise<KompiledLayout> {
  const markers = await Promise.allSettled(TEXT_MARKERS.map((file) => readRequired(dir, file)));
  const [mainModule, mainSyntaxModule, backend] = markers.map(firstRejectionWins);

  // `bigint: true` so `mtimeNs` is available: pyk reports `st_mtime_ns`
  // (`ktool/kompile.py:667-668`), and a `number` cannot represent it.  The
  // millisecond field of the same stat is what the layout leads with, because
  // that is what every JavaScript date API speaks.
  const stats = await stat(join(dir, "timestamp"), { bigint: true }).catch((error: unknown) => {
    throw isNotFound(error) ? new MissingKompiledFileError(dir, "timestamp") : error;
  });

  const [configVarsSh, allRulesTxt] = await Promise.all(
    (["configVars.sh", "allRules.txt"] as const).map((file) => readOptional(dir, file)),
  );

  return parseKompiledLayout({
    mainModule: mainModule ?? "",
    mainSyntaxModule: mainSyntaxModule ?? "",
    backend: backend ?? "",
    timestampMtimeMs: Number(stats.mtimeMs),
    timestampMtimeNs: stats.mtimeNs,
    ...(configVarsSh === undefined ? {} : { configVarsSh }),
    ...(allRulesTxt === undefined ? {} : { allRulesTxt }),
  });
}

/**
 * Load a kompiled directory: markers now, everything else on first touch.
 *
 * ```ts
 * const kompiled = await loadKompiledDefinition("imp-kompiled");
 * ```
 *
 * The obvious shape for this is a static `KompiledDefinition.load`.  It is a
 * free function here instead, and the reason is that `kompiled.ts` must not
 * touch the filesystem.  A static method on that class would have to import this
 * module, which would make the pure core depend on `node:fs` and take the
 * property away from everyone who wanted it — a bundler targeting a browser,
 * a test with an in-memory directory, a caller reading out of a tarball.  The
 * class stays constructible from a {@link KompiledSource}; this is the shell
 * that builds one from a path.
 *
 * @throws {MissingKompiledFileError} when a required marker is absent.  Missing
 *   *artifacts* are not detected here — they surface from the getter that needs
 *   them, which is the whole point of loading lazily.
 */
export async function loadKompiledDefinition(
  dir: string,
  options: KompiledDefinitionOptions = {},
): Promise<KompiledDefinition> {
  const layout = await loadKompiledLayout(dir);
  return new KompiledDefinition({ path: dir, layout, read: (artifact) => readArtifactSync(dir, artifact) }, options);
}

/**
 * The `*-kompiled` directory in `cwd`, when there is exactly one —
 * `Kompile.default_directory` (`ktool/kompile.py:228-238`).
 *
 * Two deliberate differences from pyk, both narrowing:
 *
 * - **Directories only.**  `Path().glob('*-kompiled')` matches files too, and
 *   pyk then fails later in `check_dir_path`.  Failing here says more.
 * - **Sorted.**  `readdir` order is filesystem-dependent; the error message
 *   names two candidates, and naming a *different* two on every run would make
 *   it useless.
 *
 * A **symlink** to a directory counts, which needs saying because `readdir`'s
 * `withFileTypes` is `lstat`-shaped: a symlink reports `isSymbolicLink()` and
 * `isDirectory() === false` however ordinary its target is.  pyk's
 * `Path.is_dir()` follows links, and a `foo-kompiled -> ../build/foo-kompiled`
 * is a normal thing to have, so the link is resolved with a `stat` and kept
 * only if it really points at a directory.  A dangling link is simply not a
 * candidate.
 *
 * @throws {KompiledDirNotFoundError} on zero matches or on two or more, with
 *   pyk's wording in both cases.
 */
export async function findKompiledDir(cwd: string): Promise<string> {
  const entries = await readdir(cwd, { withFileTypes: true });
  const named = entries.filter(
    (entry) => entry.name.endsWith("-kompiled") && (entry.isDirectory() || entry.isSymbolicLink()),
  );
  const resolved = await Promise.all(
    named.map(async (entry) => (entry.isDirectory() || (await isDirectory(join(cwd, entry.name))) ? entry.name : "")),
  );
  const candidates = resolved.filter((name) => name !== "").toSorted();
  if (candidates.length !== 1) throw new KompiledDirNotFoundError(cwd, candidates);
  return join(cwd, candidates[0] ?? "");
}

/** A passive observation of one expected Bison parser artifact. */
export type BisonParserArtifactInspection =
  | {
      readonly artifact: ExpectedBisonParser;
      /** The concrete filename exists; this deliberately makes no executability claim. */
      readonly status: "present" | "missing" | "unsafe-path";
      readonly executablePath: string | undefined;
      readonly libraryPath: string | undefined;
    }
  | {
      readonly artifact: ExpectedBisonParserAlias;
      /** `target` means only that `readlink` succeeded, not that the target exists. */
      readonly status: "target" | "missing" | "not-symlink" | "unsafe-path";
      readonly target: string | undefined;
      /** Present only when a link target disagrees with the forward-derived names. */
      readonly diagnostic:
        | {
            readonly kind: "unexpected-alias-target";
            readonly expected: readonly [string, string];
            readonly actual: string;
          }
        | undefined;
    };

/**
 * Stat and `readlink` the parser artifacts expected by a layout.
 *
 * This function is intentionally passive: a present native file is not called
 * executable, and no path is spawned.  Absence is normal because parser
 * generation is opt-in.  Unsafe names from a malformed external layout are
 * refused before joining them to `dir`.
 */
export async function inspectBisonParserArtifacts(
  dir: string,
  layout: KompiledLayout,
): Promise<readonly BisonParserArtifactInspection[]> {
  return Promise.all(
    expectedBisonParserArtifacts(layout).map(async (artifact): Promise<BisonParserArtifactInspection> => {
      if (artifact.kind === "concrete") {
        if (!isSafeArtifactName(artifact.executable) || !isSafeArtifactName(artifact.library)) {
          return {
            artifact,
            status: "unsafe-path",
            executablePath: undefined,
            libraryPath: undefined,
          };
        }
        const [executable, library] = await Promise.all([
          exists(join(dir, artifact.executable)),
          exists(join(dir, artifact.library)),
        ]);
        return {
          artifact,
          status: executable || library ? "present" : "missing",
          executablePath: executable ? join(dir, artifact.executable) : undefined,
          libraryPath: library ? join(dir, artifact.library) : undefined,
        };
      }

      if (!isSafeArtifactName(artifact.file))
        return {
          artifact,
          status: "unsafe-path",
          target: undefined,
          diagnostic: undefined,
        };
      try {
        const target = await readLink(join(dir, artifact.file));
        const diagnostic = artifact.expectedTargets.includes(target)
          ? undefined
          : {
              kind: "unexpected-alias-target" as const,
              expected: artifact.expectedTargets,
              actual: target,
            };
        return { artifact, status: "target", target, diagnostic };
      } catch (error) {
        if (isNotFound(error))
          return {
            artifact,
            status: "missing",
            target: undefined,
            diagnostic: undefined,
          };
        if (isNotSymlink(error))
          return {
            artifact,
            status: "not-symlink",
            target: undefined,
            diagnostic: undefined,
          };
        throw error;
      }
    }),
  );
}

/** Whether a path is a directory **after** following symlinks.  `false` if it is not there. */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

/** `stat` follows symlinks, which is exactly the passive existence question here. */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

/** Keep an externally supplied `parser(...)` value inside the kompiled directory. */
function isSafeArtifactName(file: string): boolean {
  return file !== "" && !file.includes("/") && !file.includes("\\");
}

//////////////////////////////
// Reading                  //
//////////////////////////////

/**
 * One artifact's text, synchronously, or `undefined` when it is not there.
 *
 * The filter is `ENOENT`/`ENOTDIR` and nothing else, which is deliberately
 * narrow: `EACCES` (no permission), `ELOOP` (a symlink cycle) and `EISDIR` (a
 * *directory* where an artifact should be) must all **throw**, because
 * reporting any of them as "absent" would send the caller a `--emit-json`
 * suggestion for a file that is right there.
 */
function readArtifactSync(dir: string, artifact: KompiledArtifact): string | undefined {
  try {
    return readFileSync(join(dir, artifact), "utf8");
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

/**
 * Unwrap one `Promise.allSettled` result, rethrowing whatever it rejected with.
 *
 * Written to be used as a `map` callback, because `Array.prototype.map` visits
 * in index order: the rejection that escapes is the one belonging to the
 * *earliest* file in the array, not to whichever read happened to settle first.
 * That determinism is the whole reason `loadKompiledLayout` does not use
 * `Promise.all`, whose rejection is a race between the concurrent reads — on a
 * directory where every marker is missing it would name a different file on
 * different runs.
 */
function firstRejectionWins(result: PromiseSettledResult<string>): string {
  if (result.status === "fulfilled") return result.value;
  // `PromiseRejectedResult.reason` is `any`; widen it to `unknown` rather than
  // propagating `any` out of this function.
  const reason: unknown = result.reason;
  throw reason;
}

async function readRequired(dir: string, file: string): Promise<string> {
  try {
    return await readFile(join(dir, file), "utf8");
  } catch (error) {
    if (isNotFound(error)) throw new MissingKompiledFileError(dir, file);
    throw error;
  }
}

async function readOptional(dir: string, file: string): Promise<string | undefined> {
  try {
    return await readFile(join(dir, file), "utf8");
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

/** `ENOENT` or `ENOTDIR` — "there is nothing at that path".  Nothing else. */
function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code: unknown = (error as { code?: unknown }).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** Node reports EINVAL when `readlink` is asked to read a regular file. */
function isNotSymlink(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  return (error as { code?: unknown }).code === "EINVAL";
}
