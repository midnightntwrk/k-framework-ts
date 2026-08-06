/**
 * `src/definition-cache.ts` against the real `imp-llvm-kompiled` fixture, with
 * no K installed.
 *
 * Three things need pinning and all three are observable without a stopwatch:
 * that a second load of the same directory returns **the same object** (which
 * is what "parsed once" means — every getter on `KompiledDefinition` memoises,
 * so object identity is parse identity), that touching `timestamp` invalidates
 * it (which is what makes recompiling in place safe), and that a failed load is
 * not cached.
 *
 * The fixture is copied into a scratch directory before its `timestamp` is
 * touched: the checked-in one belongs to `@kframework-ts/kompiled` and a test
 * that mutated it would corrupt another package's provenance.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ksort } from "@kframework-ts/kast";
import { MissingKompiledFileError } from "@kframework-ts/kompiled";

import { caughtAsync } from "./caught.ts";
import {
  clearKompiledDefinitionCache,
  kompiledDefinitionCacheStats,
  loadKompiledDefinitionCached,
  resetKompiledDefinitionCacheStats,
} from "../src/definition-cache.ts";
import { KPrint } from "../src/kprint.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const IMP_LLVM = join(HERE, "..", "..", "kompiled", "fixtures", "generated", "imp-llvm-kompiled");

const scratchDirs: string[] = [];

async function copyFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ktool-defcache-"));
  scratchDirs.push(root);
  const dir = join(root, "imp-llvm-kompiled");
  await cp(IMP_LLVM, dir, { recursive: true });
  return dir;
}

afterEach(async () => {
  clearKompiledDefinitionCache();
  resetKompiledDefinitionCacheStats();
  await Promise.all(scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("loadKompiledDefinitionCached", () => {
  test("the same directory yields the same instance, so compiled.json parses once", async () => {
    const first = await loadKompiledDefinitionCached(IMP_LLVM);
    const second = await loadKompiledDefinitionCached(IMP_LLVM);
    expect(second).toBe(first);
    // Object identity is parse identity: `definition` memoises inside the
    // instance, so a shared instance is a shared parse.
    expect(second.definition).toBe(first.definition);
    expect(kompiledDefinitionCacheStats()).toMatchObject({ hits: 1, misses: 1, staleReloads: 0, entries: 1 });
  });

  test("N concurrent callers share one in-flight load", async () => {
    const all = await Promise.all([1, 2, 3, 4, 5].map(() => loadKompiledDefinitionCached(IMP_LLVM)));
    const head = await loadKompiledDefinitionCached(IMP_LLVM);
    for (const one of all) expect(one).toBe(head);
    expect(kompiledDefinitionCacheStats().misses).toBe(1);
  });

  test("a relative and an absolute spelling of one directory are one entry", async () => {
    const dir = await copyFixture();
    const first = await loadKompiledDefinitionCached(dir);
    const second = await loadKompiledDefinitionCached(join(dir, "..", "imp-llvm-kompiled"));
    expect(second).toBe(first);
    expect(kompiledDefinitionCacheStats().entries).toBe(1);
  });

  test("touching `timestamp` invalidates — a definition recompiled in place is not served stale", async () => {
    const dir = await copyFixture();
    const first = await loadKompiledDefinitionCached(dir);

    // `kompile` writes `timestamp` last, so moving its mtime is exactly the
    // signal a rebuild produces.
    const later = new Date(Date.now() + 5_000);
    await utimes(join(dir, "timestamp"), later, later);

    const second = await loadKompiledDefinitionCached(dir);
    expect(second).not.toBe(first);
    expect(kompiledDefinitionCacheStats()).toMatchObject({ hits: 0, misses: 1, staleReloads: 1, entries: 1 });
  });

  test("a directory with no `timestamp` raises and is not cached", async () => {
    const dir = await copyFixture();
    await rm(join(dir, "timestamp"));

    await caughtAsync(loadKompiledDefinitionCached(dir), MissingKompiledFileError);
    expect(kompiledDefinitionCacheStats().entries).toBe(0);

    // …and once the directory is whole again, the next call succeeds rather
    // than replaying the stored rejection.
    await cp(join(IMP_LLVM, "timestamp"), join(dir, "timestamp"));
    expect((await loadKompiledDefinitionCached(dir)).path).toBe(dir);
  });

  test("clearKompiledDefinitionCache forgets one directory or all of them", async () => {
    const first = await loadKompiledDefinitionCached(IMP_LLVM);
    clearKompiledDefinitionCache(IMP_LLVM);
    expect(await loadKompiledDefinitionCached(IMP_LLVM)).not.toBe(first);
    expect(kompiledDefinitionCacheStats().entries).toBe(1);
    clearKompiledDefinitionCache();
    expect(kompiledDefinitionCacheStats().entries).toBe(0);
  });
});

describe("KPrint.load goes through the cache", () => {
  test("two printers over one directory share the parsed definition", async () => {
    const a = await KPrint.load(IMP_LLVM);
    const b = await KPrint.load(IMP_LLVM);
    expect(b.kompiled).toBe(a.kompiled);
    expect(b.definition).toBe(a.definition);
    // Distinct printers, though: the symbol-table hooks are per instance.
    expect(b).not.toBe(a);
  });

  test("`cacheDefinition: false` opts out", async () => {
    const shared = await KPrint.load(IMP_LLVM);
    const own = await KPrint.load(IMP_LLVM, { cacheDefinition: false });
    expect(own.kompiled).not.toBe(shared.kompiled);
    // Same content, independently parsed.
    expect(own.definitionHash).toBe(shared.definitionHash);
  });

  test("the cached instance still carries the konvert edge KPrint.load wires by hand", async () => {
    const kprint = await KPrint.load(IMP_LLVM);
    // `KompiledDefinition.koreToKast` throws a named error when the edge was
    // never injected; reaching a real conversion proves it was.
    const pattern = await kprint.kastToKore(kprint.definition.emptyConfig(ksort("TCell")));
    expect(await kprint.koreToKast(pattern)).toBeDefined();
  });
});
