import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const K_BIN_NAMES = new Set(["kast", "kcovr", "kore-rpc"]);
const PACKAGES = join(import.meta.dir, "..", "..");

function binNames(text: string): readonly string[] {
  const manifest: unknown = JSON.parse(text);
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) return [];
  const bin: unknown = Reflect.get(manifest, "bin");
  if (typeof bin !== "object" || bin === null || Array.isArray(bin)) return [];
  return Object.keys(bin);
}

describe("published bin names", () => {
  test("do not shadow K's executables when a package manager prepends node_modules/.bin to PATH", async () => {
    const names = await readdir(PACKAGES);
    const published = new Map<string, string>();
    const packages = await Promise.all(
      names.map(async (name): Promise<readonly [string, readonly string[]]> => {
        try {
          return [name, binNames(await readFile(join(PACKAGES, name, "package.json"), "utf8"))];
        } catch {
          // Not every directory under packages is a publishable package.
          return [name, []];
        }
      }),
    );
    for (const [name, bins] of packages) {
      for (const bin of bins) published.set(bin, name);
    }
    expect([...published.keys()].filter((bin) => K_BIN_NAMES.has(bin))).toEqual([]);
    expect(published.get("kast-ts")).toBe("kast");
    expect(published.get("kcovr-ts")).toBe("kcovr");
    expect(published.get("kore-rpc-ts")).toBe("kore-rpc");
  });
});
