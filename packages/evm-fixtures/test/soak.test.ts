/**
 * The soak plumbing: the one `envDir`, the discovery order, and the cache key.
 *
 * Hermetic — no K, no `kompile`, and no reliance on the ambient environment:
 * every test that cares about a variable sets it and restores it, because this
 * suite has to pass both on a machine that has run `kompile-soak` and on one
 * that has not.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  KOMPILE_CACHE_ENV,
  PLUGIN_PLACEHOLDER,
  SRC_PLACEHOLDER,
  EVM_CACHE_MARKER,
  EVM_CACHE_SCHEMA,
  EVM_KOMPILE_ARGV,
  EVM_PIN,
  EVM_SOAK_ENV,
  envDir,
  isCompletedCacheEntry,
  evmCacheEntry,
  evmCacheKey,
  evmCacheRoot,
  evmKompileArgv,
  evmSoakDir,
} from "../src/index.ts";
import { SoakUsageError, parseSoakArgs } from "../src/kompile-soak.ts";

const saved = new Map<string, string | undefined>();

/** Set a variable for one test, remembering what to put back. */
function withEnv(name: string, value: string | undefined): void {
  if (!saved.has(name)) saved.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  saved.clear();
});

describe("envDir — the single copy", () => {
  test("unset and empty are the same answer", () => {
    withEnv("KFRAMEWORK_TS_TEST_ONLY", undefined);
    expect(envDir("KFRAMEWORK_TS_TEST_ONLY")).toBeUndefined();
    withEnv("KFRAMEWORK_TS_TEST_ONLY", "");
    expect(envDir("KFRAMEWORK_TS_TEST_ONLY")).toBeUndefined();
  });

  test("anything else is returned verbatim, existing or not", () => {
    // Deliberately not a `statSync`: the soaks want to fail loudly on a bad
    // path rather than silently skip, so this layer does not filter.
    withEnv("KFRAMEWORK_TS_TEST_ONLY", "/nowhere/at/all");
    expect(envDir("KFRAMEWORK_TS_TEST_ONLY")).toBe("/nowhere/at/all");
  });
});

describe("evmSoakDir — the discovery order", () => {
  test("the environment variable wins over any cache entry", () => {
    withEnv(EVM_SOAK_ENV, "/somewhere/evm-test-haskell-kompiled");
    expect(evmSoakDir()).toBe("/somewhere/evm-test-haskell-kompiled");
  });

  test("an empty variable falls through rather than naming the empty path", () => {
    // With the cache root pointed at an empty directory there is nothing to
    // fall through *to*, which is what makes this assertion stable on a
    // machine that has run `kompile-soak`.
    const scratch = mkdtempSync(join(tmpdir(), "evm-fixtures-cache-"));
    try {
      withEnv(EVM_SOAK_ENV, "");
      withEnv(KOMPILE_CACHE_ENV, scratch);
      expect(evmSoakDir()).toBeUndefined();
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test("a completed cache entry is found, and an unmarked one is not", () => {
    const scratch = mkdtempSync(join(tmpdir(), "evm-fixtures-cache-"));
    try {
      withEnv(EVM_SOAK_ENV, undefined);
      withEnv(KOMPILE_CACHE_ENV, scratch);
      const entry = evmCacheEntry();
      expect(entry).toBe(join(scratch, "evm-soak", evmCacheKey()));

      // The wreckage of an interrupted build: the directory is there and the
      // marker is not.  This is exactly the case the atomic rename exists for.
      mkdirSync(entry, { recursive: true });
      expect(evmSoakDir()).toBeUndefined();

      // A marker for a *different* key is not this entry's completion either.
      writeFileSync(join(entry, EVM_CACHE_MARKER), JSON.stringify({ schema: EVM_CACHE_SCHEMA, key: "nope" }));
      expect(evmSoakDir()).toBeUndefined();

      writeFileSync(join(entry, EVM_CACHE_MARKER), JSON.stringify({ schema: EVM_CACHE_SCHEMA, key: evmCacheKey() }));
      expect(isCompletedCacheEntry(entry, evmCacheKey())).toBe(true);
      expect(evmSoakDir()).toBe(entry);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("the cache key", () => {
  test("it is pure: same inputs, same key, whatever the environment says", () => {
    const before = evmCacheKey();
    withEnv(KOMPILE_CACHE_ENV, "/some/other/root");
    withEnv(EVM_SOAK_ENV, "/some/soak");
    expect(evmCacheKey()).toBe(before);
    expect(before).toMatch(/^[0-9a-f]{64}$/u);
  });

  test("the K release is key material, so two releases cannot share a directory", () => {
    expect(evmCacheKey("7.1.999")).not.toBe(evmCacheKey(EVM_PIN.kBuiltWith));
    expect(evmCacheKey()).toBe(evmCacheKey(EVM_PIN.kBuiltWith));
  });

  test("nothing machine-specific reaches it", () => {
    // The reason `EVM_KOMPILE_ARGV` carries a placeholder and no `-o`: a key
    // that mentioned this machine's checkout would make the entry
    // undiscoverable from a test that does not know where the checkout is.
    for (const argument of EVM_KOMPILE_ARGV) expect(argument.startsWith("/")).toBe(false);
    expect(EVM_KOMPILE_ARGV).not.toContain("-o");
    expect(EVM_KOMPILE_ARGV.filter((argument) => argument.includes(SRC_PLACEHOLDER)).length).toBe(2);
    expect(EVM_KOMPILE_ARGV.filter((argument) => argument.includes(PLUGIN_PLACEHOLDER)).length).toBe(1);
  });

  test("evmKompileArgv binds the placeholder and nothing else", () => {
    const argv = evmKompileArgv("/checkout/kevm", "/checkout/plugin");
    expect(argv).toEqual([
      "--backend",
      "haskell",
      "--main-module",
      "ETHEREUM-SIMULATION",
      "--syntax-module",
      "ETHEREUM-SIMULATION",
      "-I",
      "/checkout/kevm",
      "-I",
      "/checkout/plugin",
      "--md-selector",
      "k & ! concrete",
      "--hook-namespaces",
      "JSON KRYPTO",
      "--type-inference-mode",
      "simplesub",
      "--emit-json",
      "/checkout/kevm/driver.md",
    ]);
  });
});

describe("the cache root", () => {
  test("KFRAMEWORK_TS_KOMPILE_CACHE wins, and a relative value is made absolute", () => {
    withEnv(KOMPILE_CACHE_ENV, "/an/absolute/root");
    expect(evmCacheRoot()).toBe("/an/absolute/root");
    withEnv(KOMPILE_CACHE_ENV, "relative-root");
    expect(evmCacheRoot().startsWith("/")).toBe(true);
    expect(evmCacheRoot().endsWith("relative-root")).toBe(true);
  });

  test("without it, a stable per-user location under the XDG cache", () => {
    withEnv(KOMPILE_CACHE_ENV, undefined);
    withEnv("XDG_CACHE_HOME", "/xdg/cache");
    expect(evmCacheRoot()).toBe("/xdg/cache/kframework-ts");
  });

  test("the entry is namespaced away from ktool's, which may share the root", () => {
    withEnv(KOMPILE_CACHE_ENV, "/shared");
    expect(evmCacheEntry()).toBe(join("/shared", "evm-soak", evmCacheKey()));
  });
});

describe("parseSoakArgs", () => {
  test("the defaults are all environment fallbacks, decided later", () => {
    expect(parseSoakArgs([])).toEqual({
      kBin: undefined,
      checkout: undefined,
      cacheDir: undefined,
      kVersion: undefined,
      force: false,
      allowCommitMismatch: false,
      help: false,
    });
  });

  test("every flag parses", () => {
    const options = parseSoakArgs([
      "--k-bin",
      "/k/bin",
      "--checkout",
      "/co",
      "--cache",
      "/cache",
      "--k-version",
      "7.1.400",
      "--force",
      "--allow-commit-mismatch",
      "--help",
    ]);
    expect(options).toEqual({
      kBin: "/k/bin",
      checkout: "/co",
      cacheDir: "/cache",
      kVersion: "7.1.400",
      force: true,
      allowCommitMismatch: true,
      help: true,
    });
  });

  test("a flag missing its value is refused rather than swallowing the next flag", () => {
    expect(() => parseSoakArgs(["--checkout"])).toThrow(SoakUsageError);
    expect(() => parseSoakArgs(["--checkout", "--force"])).toThrow(SoakUsageError);
    expect(() => parseSoakArgs(["--nonsense"])).toThrow(SoakUsageError);
  });
});
