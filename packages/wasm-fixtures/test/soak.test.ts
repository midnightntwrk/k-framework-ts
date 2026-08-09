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
  SRC_PLACEHOLDER,
  WASM_CACHE_MARKER,
  WASM_CACHE_SCHEMA,
  WASM_KOMPILE_ARGV,
  WASM_PIN,
  WASM_SOAK_ENV,
  envDir,
  isCompletedCacheEntry,
  wasmCacheEntry,
  wasmCacheKey,
  wasmCacheRoot,
  wasmKompileArgv,
  wasmSoakDir,
  wasmSoakCacheMarkerSchema,
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

describe("wasm soak cache marker schema", () => {
  test("preserves forward-compatible fields", () => {
    expect(wasmSoakCacheMarkerSchema.parse({ schema: WASM_CACHE_SCHEMA, key: "expected", future: true })).toEqual({
      schema: WASM_CACHE_SCHEMA,
      key: "expected",
      future: true,
    });
  });

  test("rejects malformed marker identities", () => {
    expect(wasmSoakCacheMarkerSchema.safeParse({ schema: "1", key: "expected" }).success).toBe(false);
    expect(wasmSoakCacheMarkerSchema.safeParse({ schema: WASM_CACHE_SCHEMA }).success).toBe(false);
  });
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

describe("wasmSoakDir — the discovery order", () => {
  test("the environment variable wins over any cache entry", () => {
    withEnv(WASM_SOAK_ENV, "/somewhere/wasm-test-haskell-kompiled");
    expect(wasmSoakDir()).toBe("/somewhere/wasm-test-haskell-kompiled");
  });

  test("an empty variable falls through rather than naming the empty path", () => {
    // With the cache root pointed at an empty directory there is nothing to
    // fall through *to*, which is what makes this assertion stable on a
    // machine that has run `kompile-soak`.
    const scratch = mkdtempSync(join(tmpdir(), "wasm-fixtures-cache-"));
    try {
      withEnv(WASM_SOAK_ENV, "");
      withEnv(KOMPILE_CACHE_ENV, scratch);
      expect(wasmSoakDir()).toBeUndefined();
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test("a completed cache entry is found, and an unmarked one is not", () => {
    const scratch = mkdtempSync(join(tmpdir(), "wasm-fixtures-cache-"));
    try {
      withEnv(WASM_SOAK_ENV, undefined);
      withEnv(KOMPILE_CACHE_ENV, scratch);
      const entry = wasmCacheEntry();
      expect(entry).toBe(join(scratch, "wasm-soak", wasmCacheKey()));

      // The wreckage of an interrupted build: the directory is there and the
      // marker is not.  This is exactly the case the atomic rename exists for.
      mkdirSync(entry, { recursive: true });
      expect(wasmSoakDir()).toBeUndefined();

      // A marker for a *different* key is not this entry's completion either.
      writeFileSync(join(entry, WASM_CACHE_MARKER), JSON.stringify({ schema: WASM_CACHE_SCHEMA, key: "nope" }));
      expect(wasmSoakDir()).toBeUndefined();

      writeFileSync(
        join(entry, WASM_CACHE_MARKER),
        JSON.stringify({ schema: WASM_CACHE_SCHEMA, key: wasmCacheKey(), future: true }),
      );
      expect(isCompletedCacheEntry(entry, wasmCacheKey())).toBe(true);
      expect(wasmSoakDir()).toBe(entry);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("the cache key", () => {
  test("it is pure: same inputs, same key, whatever the environment says", () => {
    const before = wasmCacheKey();
    withEnv(KOMPILE_CACHE_ENV, "/some/other/root");
    withEnv(WASM_SOAK_ENV, "/some/soak");
    expect(wasmCacheKey()).toBe(before);
    expect(before).toMatch(/^[0-9a-f]{64}$/u);
  });

  test("the K release is key material, so two releases cannot share a directory", () => {
    expect(wasmCacheKey("7.1.999")).not.toBe(wasmCacheKey(WASM_PIN.kBuiltWith));
    expect(wasmCacheKey()).toBe(wasmCacheKey(WASM_PIN.kBuiltWith));
  });

  test("nothing machine-specific reaches it", () => {
    // The reason `WASM_KOMPILE_ARGV` carries a placeholder and no `-o`: a key
    // that mentioned this machine's checkout would make the entry
    // undiscoverable from a test that does not know where the checkout is.
    for (const argument of WASM_KOMPILE_ARGV) expect(argument.startsWith("/")).toBe(false);
    expect(WASM_KOMPILE_ARGV).not.toContain("-o");
    expect(WASM_KOMPILE_ARGV.filter((argument) => argument.includes(SRC_PLACEHOLDER)).length).toBe(2);
  });

  test("wasmKompileArgv binds the placeholder and nothing else", () => {
    const argv = wasmKompileArgv("/checkout/pykwasm/src/pykwasm/kdist");
    expect(argv).toEqual([
      "--backend",
      "haskell",
      "--main-module",
      "WASM-TEST",
      "--syntax-module",
      "WASM-TEST-SYNTAX",
      "-I",
      "/checkout/pykwasm/src/pykwasm/kdist",
      "--md-selector",
      "k",
      "--emit-json",
      "/checkout/pykwasm/src/pykwasm/kdist/wasm-semantics/test.md",
    ]);
  });
});

describe("the cache root", () => {
  test("KFRAMEWORK_TS_KOMPILE_CACHE wins, and a relative value is made absolute", () => {
    withEnv(KOMPILE_CACHE_ENV, "/an/absolute/root");
    expect(wasmCacheRoot()).toBe("/an/absolute/root");
    withEnv(KOMPILE_CACHE_ENV, "relative-root");
    expect(wasmCacheRoot().startsWith("/")).toBe(true);
    expect(wasmCacheRoot().endsWith("relative-root")).toBe(true);
  });

  test("without it, a stable per-user location under the XDG cache", () => {
    withEnv(KOMPILE_CACHE_ENV, undefined);
    withEnv("XDG_CACHE_HOME", "/xdg/cache");
    expect(wasmCacheRoot()).toBe("/xdg/cache/kframework-ts");
  });

  test("the entry is namespaced away from ktool's, which may share the root", () => {
    withEnv(KOMPILE_CACHE_ENV, "/shared");
    expect(wasmCacheEntry()).toBe(join("/shared", "wasm-soak", wasmCacheKey()));
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
