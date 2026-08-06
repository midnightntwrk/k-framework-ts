/** Offline tests for the opt-in real-K harness.
 *
 * The fake `kompile` is a shell script rather than a mock: this verifies the
 * process boundary, forced argv, output validation and cache marker without a
 * K installation.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  K_BIN_ENV,
  kBin,
  kompileCached,
  kompileCacheKey,
  KompileHarnessError,
  kTestEnabled,
  requireKTestEnvironment,
} from "../src/testing.ts";
import { caughtAsync } from "./caught.ts";

const scratchDirs: string[] = [];
const priorKBin = process.env[K_BIN_ENV];

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ktool-testing-"));
  scratchDirs.push(dir);
  return dir;
}

async function fakeK(version = "v7.1.337"): Promise<{ bin: string; count: string }> {
  const dir = await scratch();
  const bin = join(dir, "bin");
  const count = join(dir, "calls");
  await mkdir(bin);
  const script = `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "K version:    ${version}"
  exit 0
fi
out=""
argv="$*"
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output-definition" ]; then
    shift
    out="$1"
  fi
  shift
done
mkdir -p "$out"
printf '%s\\n' "$argv" > "$out/argv"
printf 'run\\n' >> "${count}"
`;
  const command = join(bin, "kompile");
  await writeFile(command, script);
  await chmod(command, 0o755);
  return { bin, count };
}

afterEach(async () => {
  if (priorKBin === undefined) delete process.env[K_BIN_ENV];
  else process.env[K_BIN_ENV] = priorKBin;
  await Promise.all(scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("the K opt-in", () => {
  test("is disabled for unset and empty KFRAMEWORK_TS_K_BIN", () => {
    delete process.env[K_BIN_ENV];
    expect(kTestEnabled()).toBe(false);
    expect(kBin()).toBeUndefined();
    process.env[K_BIN_ENV] = "";
    expect(kTestEnabled()).toBe(false);
  });

  test("rejects a compilation when no K installation was selected", async () => {
    delete process.env[K_BIN_ENV];
    const error = await caughtAsync(requireKTestEnvironment(), KompileHarnessError);
    expect(error.code).toBe("k-unavailable");
  });

  test("requires exactly the pinned K release", async () => {
    const { bin } = await fakeK("v7.1.336");
    const error = await caughtAsync(requireKTestEnvironment({ kBin: bin }), KompileHarnessError);
    expect(error.code).toBe("version-mismatch");
    expect(error.actual).toBe("v7.1.336");
  });
});

describe("kompileCacheKey", () => {
  test("is stable across inline whitespace and distinguishes source text", () => {
    const first = kompileCacheKey({
      backend: "haskell",
      definition: "\n module TEST endmodule\n",
      mainModule: "TEST",
    });
    const same = kompileCacheKey({ backend: "haskell", definition: "module TEST endmodule", mainModule: "TEST" });
    const changed = kompileCacheKey({ backend: "haskell", definition: "module OTHER endmodule", mainModule: "TEST" });
    expect(first).toBe(same);
    expect(changed).not.toBe(first);
  });

  test("changes when canonical kompile arguments change", () => {
    const standard = kompileCacheKey({ backend: "haskell", mainFile: "test.k" });
    const changed = kompileCacheKey({ backend: "haskell", mainFile: "test.k", syntaxModule: "TEST" });
    expect(standard).not.toBe(changed);
  });
});

describe("kompileCached", () => {
  test("compiles once, preserves forced flags, and reuses a persistent entry", async () => {
    const { bin, count } = await fakeK();
    const cacheDir = await scratch();
    const sourceDir = await scratch();
    const mainFile = join(sourceDir, "test.k");
    await writeFile(mainFile, "module TEST endmodule\n");

    const spec = { backend: "haskell" as const, mainFile, mainModule: "TEST" };
    const options = { kBin: bin, cacheDir };
    const first = await kompileCached(spec, options);
    const second = await kompileCached(spec, options);

    expect(second).toBe(first);
    expect(await readFile(count, "utf8")).toBe("run\n");
    const argv = await readFile(join(first, "argv"), "utf8");
    expect(argv).toContain("--type-inference-mode checked");
    expect(argv).toContain("--warnings-to-errors");
  });

  test("deduplicates inline definitions by normalized text", async () => {
    const { bin, count } = await fakeK();
    const cacheDir = await scratch();
    const options = { kBin: bin, cacheDir };
    const first = await kompileCached(
      { backend: "haskell", definition: "\n module TEST endmodule\n", mainModule: "TEST" },
      options,
    );
    const second = await kompileCached(
      { backend: "haskell", definition: "module TEST endmodule", mainModule: "TEST" },
      options,
    );

    expect(second).toBe(first);
    expect(await readFile(count, "utf8")).toBe("run\n");
  });
});
