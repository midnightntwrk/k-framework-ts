/**
 * Parsing `compiled.json` and `definition.kore` **once** per kompiled
 * directory, per build of that directory.
 *
 * # What this is, and what it is not
 *
 * `@kframework-ts/kompiled`'s {@link loadKompiledDefinition} already memoises
 * *within* an instance: `kompiled.definition` parses `compiled.json` on first
 * touch and never again, `kompiled.koreDefinition` does the same for
 * `definition.kore` (`packages/kompiled/src/kompiled.ts:186`, "Every getter
 * memoises"). What it does not do — deliberately, because it is the layer with
 * no policy — is share that work *between* instances. `KPrint.load(dir)` called
 * twice returns two `KompiledDefinition`s and parses everything twice, and a
 * loop that constructs a printer per candidate program pays for a 71 MB
 * `definition.kore` parse per iteration.
 *
 * This module is that policy: one instance per `(directory, build)`, handed to
 * every caller that asks for the same pair.
 *
 * # The key is `timestamp`'s mtime, and that is not arbitrary
 *
 * `kompile` writes the `timestamp` marker **last**
 * (`KompileFrontEnd.java:116`), after every artifact in the directory — which
 * is the only reason its mtime means anything, and is why `make` keys off it
 * too. So `(resolve(dir), timestampMtimeNs)` identifies a *build*, not a path:
 * a definition recompiled in place — precisely what a mutation harness does,
 * hundreds of times, into the same output directory — gets a new mtime and
 * therefore a new entry, with no explicit invalidation from the caller.
 *
 * Nanoseconds, not milliseconds: `KompiledLayout.timestampMtimeNs` is a
 * `bigint` and two kompilations of a small definition into the same directory
 * can land inside the same millisecond. The millisecond field would make that
 * a stale hit; the nanosecond field does not.
 *
 * A hit still costs one `stat` — there is no way to answer "is this the same
 * build?" without asking the filesystem, and a cache that skipped the question
 * would serve a stale definition, which is the one failure mode that must not
 * happen. A `stat` is microseconds; parsing `compiled.json` for a real
 * semantics is seconds.
 *
 * # pyk's version of this
 *
 * pyk caches definition loading with `@cached_property` on `KPrint.definition`
 * (`ktool/kprint.py:218-220`) and `KPrint.definition_hash`, and its `KoreClient`
 * layer writes a `pyk-definition.kore.json` **into the kompiled directory**
 * (`kore/kompiled.py:103`) — a write so unwelcome that `kompile` grew
 * `--read-only-kompiled-directory` (`ktool/kompile.py:622`) to forbid it. Both
 * halves are per-object or on-disk; pyk has no cross-instance in-process cache,
 * and this package writes nothing to a directory it read (`kompiled/src/fs.ts`
 * header). So: same intent, different mechanism, and the divergence is the
 * point rather than an accident.
 *
 * # The idiom
 *
 * `distribution.ts`'s `getKDistribution` is the house pattern for this: a
 * module-level memo holding a **promise**, so concurrent callers share one
 * in-flight computation rather than racing, plus an explicit
 * `clear…Cache()` for the caller who changed the world underneath it. This is
 * that, keyed.
 */

import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { loadKompiledDefinition, type KompiledDefinition } from "@kframework-ts/kompiled";
import { koreToKast as konvertKoreToKast } from "@kframework-ts/konvert";

/** How a {@link loadKompiledDefinitionCached} call was served. */
export interface KompiledCacheStats {
  /** Calls served from an existing entry whose build was still current. */
  readonly hits: number;
  /** Calls that had to load, because nothing was cached for the directory. */
  readonly misses: number;
  /** Calls that had to load because the directory had been rebuilt underneath them. */
  readonly staleReloads: number;
  /** Directories currently held. */
  readonly entries: number;
}

interface CacheEntry {
  /** The `timestamp` mtime this entry was loaded at. */
  readonly build: bigint;
  readonly definition: Promise<KompiledDefinition>;
}

const cache = new Map<string, CacheEntry>();
let hits = 0;
let misses = 0;
let staleReloads = 0;

/**
 * Load a kompiled directory, reusing the parse when the directory has not been
 * rebuilt.
 *
 * ```ts
 * // N calls, one parse of compiled.json and one of definition.kore.
 * for (const program of corpus) {
 *   const kompiled = await loadKompiledDefinitionCached(dir);
 *   … // kompiled.definition, kompiled.koreDefinition
 * }
 * ```
 *
 * The returned {@link KompiledDefinition} is **shared**, and that is safe
 * because it is read-only: every getter memoises and nothing on it mutates the
 * definition. A caller that intends to mutate — or that wants a different
 * `koreToKast` edge than the `@kframework-ts/konvert` one wired in here —
 * should call `loadKompiledDefinition` directly and own its instance.
 *
 * A rejected load is not cached: the entry is dropped so a directory fixed
 * after a failed first attempt is retried rather than failing forever. That is
 * the same rule `testing.ts`'s `kompileCached` applies to a failed build.
 *
 * @throws {import('@kframework-ts/kompiled').MissingKompiledFileError} when a
 *   marker file is absent — including `timestamp`, which is `stat`ed here
 *   before anything else is read.
 */
export async function loadKompiledDefinitionCached(definitionDir: string): Promise<KompiledDefinition> {
  const key = resolve(definitionDir);
  const build = await buildStamp(key);

  const existing = cache.get(key);
  if (existing !== undefined) {
    if (build !== undefined && existing.build === build) {
      hits += 1;
      return existing.definition;
    }
    staleReloads += 1;
  } else {
    misses += 1;
  }

  // The `konvert` edge `@kframework-ts/kompiled` leaves injected, wired exactly
  // as `KPrint.load` wires it: the closure reads `definition` only after the
  // promise it belongs to has resolved.
  let definition: KompiledDefinition;
  const loading = (async () => {
    definition = await loadKompiledDefinition(definitionDir, {
      koreToKast: (pattern) => konvertKoreToKast(definition.definition, pattern),
    });
    return definition;
  })();

  // `build === undefined` means the `timestamp` marker could not be `stat`ed,
  // which `loadKompiledDefinition` is about to turn into a
  // `MissingKompiledFileError`. Do not cache that: the entry would have no
  // build to compare against and would answer every later call with the same
  // rejection even after the directory appeared.
  if (build !== undefined) {
    const entry: CacheEntry = { build, definition: loading };
    cache.set(key, entry);
    void loading.catch(() => {
      if (cache.get(key) === entry) cache.delete(key);
    });
  }

  return loading;
}

/**
 * Forget one directory, or all of them.
 *
 * Rarely needed — a rebuild moves `timestamp`'s mtime and invalidates itself —
 * but a test that wants to observe a cold load, or a process that has just
 * deleted a directory, should not have to wait for that.
 */
export function clearKompiledDefinitionCache(definitionDir?: string): void {
  if (definitionDir === undefined) cache.clear();
  else cache.delete(resolve(definitionDir));
}

/** Counters since process start, for a caller who wants to prove the loop parses once. */
export function kompiledDefinitionCacheStats(): KompiledCacheStats {
  return Object.freeze({ hits, misses, staleReloads, entries: cache.size });
}

/** Reset {@link kompiledDefinitionCacheStats}' counters without dropping entries. */
export function resetKompiledDefinitionCacheStats(): void {
  hits = 0;
  misses = 0;
  staleReloads = 0;
}

/**
 * The `timestamp` marker's mtime in nanoseconds, or `undefined` when it is not
 * there.
 *
 * `undefined` is not an error here: it is the "this is not a kompiled directory
 * (yet)" answer, and the caller turns it into the load's own
 * `MissingKompiledFileError` rather than inventing a second one with a worse
 * message.
 */
async function buildStamp(definitionDir: string): Promise<bigint | undefined> {
  try {
    return (await stat(join(definitionDir, "timestamp"), { bigint: true })).mtimeNs;
  } catch {
    return undefined;
  }
}
