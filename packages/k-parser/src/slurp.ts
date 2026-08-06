/**
 * `requires`-slurping — the **one** filesystem-touching module in this package.
 *
 * A transcription of pyk `kast/utils.py` (the whole file, 87 L, at K
 * **v7.1.337**): {@link parseOuter} and {@link slurpDefinitions} plus the
 * require-resolution rule they share.  Everything else here is a pure function
 * of strings, and this file is why the package root does not export it —
 * `@kframework-ts/k-parser` stays importable in a browser and `.../slurp` is
 * the opt-in half, the same split `@kframework-ts/kompiled` makes with `./core`
 * (inverted: there the fs half is the default).
 *
 * Paths in the signatures are `string`, never `node:path`/`node:fs` types
 * (`tsconfig.build.json`'s rule), so nothing node-shaped leaks into a
 * consumer's `.d.ts`.
 *
 * # The three contract items
 *
 * 1. **DFS order** (`utils.py:55-66`).  A worklist with `pop()` off
 *    the end, pushed with the file's requires **reversed**, so the first
 *    `require` is visited first.  `fixtures/parse-outer/d.k` pins the result:
 *    `d.k` requires `b.k` then `c.k`, `b.k` and `c.k` both require `a.k`, and
 *    the module order in the output is `D-SYNTAX D B-SYNTAX B A-SYNTAX A
 *    C-SYNTAX C` — depth-first, first-require-first, `a.k` visited under `b.k`
 *    and skipped under `c.k`.
 * 2. **Dedup by resolved path** (`utils.py:49,59`).  See
 *    {@link FileSystem.resolve} and {@link NODE_FILE_SYSTEM} for what
 *    "resolved" means here, and why it resolves symlinks.
 * 3. **`parseOuter` drops requires** (`utils.py:36-37`).  It takes
 *    the *modules* of every parsed file and rebuilds a `Definition` from them
 *    alone, so `KDefinition.requires` is always `[]`.  `d.k.expected.json` pins
 *    that too.
 *
 * # Markdown selection is gated on the suffix, nothing else
 *
 * `.md` in, `selectCodeBlocks` runs; anything else in, the text is parsed as
 * written (`utils.py:74-75`).  A `.k` file full of fences is a syntax error,
 * not a literate definition.  The default selector is `'k'`
 * (`utils.py:22-28,47`) — note that this is *not* `selectCodeBlocks`'s own
 * default, which selects every block.
 *
 * # The filesystem seam
 *
 * {@link FileSystem} is a three-method interface with a `node:fs` default.
 * Passing your own makes {@link slurpDefinitions} run over an in-memory map,
 * which is how the ordering and dedup rules are tested without touching a disk;
 * the fixture tests use the real one, because resolution against real
 * directories is half of what they are checking.
 */

import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve as resolvePath } from "node:path";
import { KDefinition } from "@kframework-ts/kast";
import { astToKast, type AstToKastOptions } from "./astToKast.js";
import { selectCodeBlocks } from "./markdown.js";
import { OuterParser } from "./parser.js";
import { definition as makeDefinition, type Definition, type Module } from "./syntax.js";

//////////////////////////////
// The filesystem seam      //
//////////////////////////////

/**
 * The three operations slurping needs from a filesystem.
 *
 * Deliberately minimal and synchronous: pyk's is `Path.read_text`,
 * `Path.is_file` and `Path.resolve`, and an async port would make
 * {@link parseOuter} `async` for no gain — the files are small and the walk is
 * inherently sequential.
 */
export interface FileSystem {
  /** The file's text, decoded as UTF-8.  Throws when it cannot be read. */
  readFile(path: string): string;
  /** Whether the path names an existing regular file (`Path.is_file`). */
  isFile(path: string): boolean;
  /**
   * The absolute, canonical form of a path — the dedup key.
   *
   * The default resolves symlinks (see {@link NODE_FILE_SYSTEM}); a custom one
   * need only be idempotent and injective enough that two spellings of the same
   * file agree.
   */
  resolve(path: string): string;
}

/**
 * The default {@link FileSystem}, backed by `node:fs`.
 *
 * `resolve` is `realpathSync.native` with a `path.resolve` fallback, which is
 * the closest match to Python's `Path.resolve()` — pyk's dedup key
 * (`utils.py:49,59,86`).  `Path.resolve()` makes the path absolute *and*
 * resolves symlinks, and the difference matters: two `require`s reaching one
 * file through different symlinked include directories must collapse to one
 * entry, and `path.resolve` alone would not collapse them.  The fallback
 * exists because `realpath` throws for a path that does not exist, while
 * `Path.resolve()` does not — the only caller that can hit that is
 * {@link slurpDefinitions} on a main file that is missing, and a clean
 * `ENOENT` from the subsequent read beats an opaque one from `realpath`.
 */
export const NODE_FILE_SYSTEM: FileSystem = Object.freeze({
  readFile(path: string): string {
    return readFileSync(path, "utf8");
  },
  isFile(path: string): boolean {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  },
  resolve(path: string): string {
    const absolute = resolvePath(path);
    try {
      return realpathSync.native(absolute);
    } catch {
      return absolute;
    }
  },
});

//////////////////////////////
// Errors                   //
//////////////////////////////

/**
 * A `require`d file was not found in any of the searched directories —
 * `FileNotFoundError` at `utils.py:87`, whose message shape this keeps.
 *
 * `name` is set explicitly: `instanceof` across two copies of a package is
 * unreliable, `error.name` is not.
 */
export class RequireNotFoundError extends Error {
  /** The path as it was written in the `requires` sentence. */
  readonly path: string;
  /** The directories searched, in the order they were searched. */
  readonly searchedPaths: readonly string[];

  constructor(path: string, searchedPaths: readonly string[]) {
    super(`${path} not found. Searched paths: [${searchedPaths.map((dir) => `'${dir}'`).join(", ")}]`);
    this.name = "RequireNotFoundError";
    this.path = path;
    this.searchedPaths = Object.freeze([...searchedPaths]);
  }
}

//////////////////////////////
// Options                  //
//////////////////////////////

/** What {@link slurpDefinitions} accepts (`utils.py:42-48`). */
export interface SlurpOptions {
  /** Directories searched after the requiring file's own, in order. */
  readonly includeDirs?: readonly string[];
  /** The markdown selector for `.md` files.  Defaults to `'k'`. */
  readonly mdSelector?: string;
  /** Whether parsed nodes record the file they came from.  Defaults to `true`. */
  readonly includeSource?: boolean;
  /** The filesystem to read through.  Defaults to {@link NODE_FILE_SYSTEM}. */
  readonly fs?: FileSystem;
}

/** What {@link parseOuter} accepts — {@link SlurpOptions} plus the conversion's. */
export interface ParseOuterOptions extends SlurpOptions, AstToKastOptions {}

//////////////////////////////
// slurp                    //
//////////////////////////////

/**
 * Parse a file and everything it `require`s, transitively
 * (`utils.py:42-67`).
 *
 * The result is keyed by **resolved** path and ordered by visit — which is what
 * decides module order downstream, since {@link parseOuter} concatenates the
 * modules in iteration order.
 *
 * ```ts
 * const files = slurpDefinitions("semantics/imp.k", { includeDirs: ["include"] });
 * for (const [path, definition] of files) console.log(path, definition.modules.length);
 * ```
 *
 * The walk is a loop over an explicit stack, not recursion — the package's
 * rule, and here it is upstream's shape as well.
 */
export function slurpDefinitions(mainFile: string, options: SlurpOptions = {}): Map<string, Definition> {
  const fs = options.fs ?? NODE_FILE_SYSTEM;
  const includeDirs = options.includeDirs ?? [];
  // `md_selector or 'k'` (`utils.py:48`) — Python truthiness, so the empty
  // string ALSO falls back to `'k'`.  `??` would let `""` through and select
  // every block.
  const mdSelector = options.mdSelector || "k";
  const includeSource = options.includeSource ?? true;

  const result = new Map<string, Definition>();
  const pending: string[] = [fs.resolve(mainFile)];

  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    if (result.has(current)) continue;

    const parsed = parseFile(current, mdSelector, includeSource, fs);
    const requiring = current;
    const resolved = parsed.requires.map((item) => resolveRequire(item.path, requiring, includeDirs, fs));
    // `pending += reversed(...)` (`utils.py:63`): reversing here plus popping
    // off the end is what makes the *first* require the first one visited.
    resolved.reverse();
    pending.push(...resolved);

    result.set(current, parsed);
  }

  return result;
}

/**
 * `_parse_file` (`utils.py:70-78`) — markdown selection gated on the suffix.
 *
 * "Suffix" is `Path.suffix`'s notion: a file named exactly `.md` has *no*
 * suffix (`Path('.md').suffix == ''`) and is parsed as raw K, so the gate
 * tests the basename, not the whole path.
 */
function parseFile(file: string, mdSelector: string, includeSource: boolean, fs: FileSystem): Definition {
  const raw = fs.readFile(file);
  const base = file.slice(Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\")) + 1);
  const isMarkdown = base.endsWith(".md") && base !== ".md";
  const text = isMarkdown ? selectCodeBlocks(raw, mdSelector) : raw;
  return new OuterParser(text, includeSource ? file : undefined).definition();
}

/**
 * `_resolve_require` (`utils.py:81-87`) — the requiring file's own directory
 * first, then each include directory in order.
 *
 * The first candidate that *is a file* wins; the resolved form of that
 * candidate is returned, so the dedup key is canonical.
 */
export function resolveRequire(
  path: string,
  requiringFile: string,
  includeDirs: readonly string[] = [],
  fs: FileSystem = NODE_FILE_SYSTEM,
): string {
  const tryDirs = [dirname(requiringFile), ...includeDirs];
  for (const dir of tryDirs) {
    const candidate = isAbsolute(path) ? path : joinPath(dir, path);
    if (fs.isFile(candidate)) return fs.resolve(candidate);
  }
  throw new RequireNotFoundError(path, tryDirs);
}

/**
 * `dir / path` — Python's `PurePath.__truediv__`, which is *not* `path.join`:
 * an absolute right-hand side replaces the left entirely, and nothing is
 * normalised away.  Only the first of those two differences is reachable here
 * (the caller checks `isAbsolute` first), but the spelling stays explicit.
 */
function joinPath(dir: string, path: string): string {
  if (isAbsolute(path)) return path;
  return dir === "" ? path : `${dir}/${path}`;
}

//////////////////////////////
// parseOuter               //
//////////////////////////////

/**
 * Parse a definition and everything it requires into a `KDefinition`
 * (`utils.py:22-39`).
 *
 * ```ts
 * const definition = parseOuter("semantics/imp.k", "IMP", { includeDirs: ["include"] });
 * console.log(definition.allModules.length);
 * ```
 *
 * `requires` is dropped, not converted: the returned `KDefinition.requires` is
 * always `[]` (`utils.py:36-37`).  The modules of every file appear in visit
 * order, file by file, module by module within a file.
 *
 * `mainModule` must name one of them — `KDefinition`'s constructor throws
 * otherwise, which is where a typo in `--main-module` surfaces.
 */
export function parseOuter(definitionFile: string, mainModule: string, options: ParseOuterOptions = {}): KDefinition {
  const parsedFiles = slurpDefinitions(definitionFile, options);
  const modules: Module[] = [];
  for (const parsed of parsedFiles.values()) modules.push(...parsed.modules);
  return astToKast(makeDefinition({ modules }), mainModule, options);
}
