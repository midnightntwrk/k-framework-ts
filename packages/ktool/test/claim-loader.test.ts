/**
 * `src/claim-loader.ts`: the cache decision, the digest, and the wire shape.
 *
 * `claim_loader.py` has **no test upstream at all**.  What it is worth testing
 * is not the happy path — that is `ClaimIndex`'s, already covered — but the
 * three things the cache can get wrong: calling the parser when it should not,
 * *not* calling it when it should, and writing a file the next run cannot read.
 *
 * The parser is a fake ({@link recordingParser}), so no `kprove` runs and the
 * whole file is pure apart from a scratch directory.  The spec it parses is the
 * vendored `fixtures/upstream/multi-claim-spec.k`, copied into that directory
 * so the `<spec>.json` the loader writes never lands in `fixtures/`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { KFlatModuleList } from "@kframework-ts/kast";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ClaimLoader,
  claimCacheFile,
  claimDigest,
  claimModuleListFromDict,
  claimModuleListToDict,
  type ModuleParser,
  type ParseModulesOptions,
} from "../src/claim-loader.ts";
import { ClaimIndexError } from "../src/claim-index.ts";
import { caughtAsync } from "./caught.ts";
import { decodeModuleList } from "../src/parse-modules.ts";

//////////////////////////////
// Fixtures and helpers     //
//////////////////////////////

const FIXTURES = join(import.meta.dir, "..", "fixtures");
const SPEC_K = join(FIXTURES, "upstream", "multi-claim-spec.k");

const MODULE_LIST: KFlatModuleList = decodeModuleList(
  readFileSync(join(FIXTURES, "generated", "multi-claim-spec.modulelist.json"), "utf8"),
);

const scratchDirs: string[] = [];

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ktool-claim-loader-"));
  scratchDirs.push(dir);
  return dir;
}

/** A scratch copy of the vendored spec, so the cache file lands outside `fixtures/`. */
async function specCopy(): Promise<string> {
  const dir = await scratch();
  const spec = join(dir, "multi-claim-spec.k");
  await copyFile(SPEC_K, spec);
  return spec;
}

afterEach(async () => {
  await Promise.all(scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface RecordingParser extends ModuleParser {
  readonly calls: { specFile: string; options: ParseModulesOptions }[];
}

/** A `ModuleParser` that records what it was asked and answers with the fixture. */
function recordingParser(result: KFlatModuleList = MODULE_LIST): RecordingParser {
  const calls: { specFile: string; options: ParseModulesOptions }[] = [];
  return {
    calls,
    parseModules: (specFile, options = {}) => {
      calls.push({ specFile, options });
      return Promise.resolve(result);
    },
  };
}

//////////////////////////////
// The cache file's path    //
//////////////////////////////

describe("claimCacheFile", () => {
  test("replaces the last suffix, next to the spec (claim_loader.py:62)", () => {
    expect(claimCacheFile("/a/b/spec.k")).toBe("/a/b/spec.json");
    expect(claimCacheFile("spec.k")).toBe("spec.json");
  });

  test("replaces only the LAST suffix, as Path.with_suffix does", () => {
    expect(claimCacheFile("/a/my.spec.k")).toBe("/a/my.spec.json");
  });

  test("appends when there is no suffix", () => {
    expect(claimCacheFile("/a/spec")).toBe("/a/spec.json");
  });

  test("treats a leading dot as part of the name, not a suffix", () => {
    // `Path('.k').suffix == ''`.
    expect(claimCacheFile("/a/.k")).toBe("/a/.k.json");
  });

  test("is not confused by a dot in a parent directory", () => {
    expect(claimCacheFile("/a.b/spec.k")).toBe("/a.b/spec.json");
    expect(claimCacheFile("/a.b/spec")).toBe("/a.b/spec.json");
  });
});

//////////////////////////////
// The digest               //
//////////////////////////////

describe("claimDigest", () => {
  test("is a lowercase sha256 hex string", () => {
    expect(claimDigest(SPEC_K)).toMatch(/^[0-9a-f]{64}$/u);
  });

  test("is stable across calls", () => {
    expect(claimDigest(SPEC_K)).toBe(claimDigest(SPEC_K));
  });

  test("changes when the spec's text changes", async () => {
    const spec = await specCopy();
    const before = claimDigest(spec);
    await writeFile(spec, `${await readFile(spec, "utf8")}\nmodule EXTRA endmodule\n`, "utf8");
    expect(claimDigest(spec)).not.toBe(before);
  });

  test("changes when a REQUIRED file changes, not just the spec", async () => {
    // This is the whole reason the digest is over `slurpDefinitions` rather
    // than over the spec's bytes (`claim_loader.py:97-101`).
    const dir = await scratch();
    const required = join(dir, "lib.k");
    const spec = join(dir, "spec.k");
    await writeFile(required, 'module LIB\n  syntax Foo ::= "a"\nendmodule\n', "utf8");
    await writeFile(spec, 'requires "lib.k"\n\nmodule SPEC\n  imports LIB\nendmodule\n', "utf8");

    const before = claimDigest(spec);
    await writeFile(required, 'module LIB\n  syntax Foo ::= "a" | "b"\nendmodule\n', "utf8");
    expect(claimDigest(spec)).not.toBe(before);
  });

  test("changes when an include directory changes what a require resolves to", async () => {
    const dir = await scratch();
    const one = join(dir, "one");
    const two = join(dir, "two");
    await Bun.write(join(one, "lib.k"), 'module LIB\n  syntax Foo ::= "a"\nendmodule\n');
    await Bun.write(join(two, "lib.k"), 'module LIB\n  syntax Foo ::= "b"\nendmodule\n');
    const spec = join(dir, "spec.k");
    await writeFile(spec, 'requires "lib.k"\n\nmodule SPEC\n  imports LIB\nendmodule\n', "utf8");

    expect(claimDigest(spec, { includeDirs: [one] })).not.toBe(claimDigest(spec, { includeDirs: [two] }));
  });

  test("a builtinDir that changes nothing still changes nothing", async () => {
    // The extra include directory only matters when it resolves a `require`;
    // passing one that resolves nothing must not perturb the digest, so a
    // caller without K on PATH gets the same answer for a self-contained spec.
    const dir = await scratch();
    expect(claimDigest(SPEC_K, { builtinDir: dir })).toBe(claimDigest(SPEC_K));
  });

  test("propagates a missing require rather than hashing a partial parse", async () => {
    const dir = await scratch();
    const spec = join(dir, "spec.k");
    await writeFile(spec, 'requires "nowhere.k"\n\nmodule SPEC endmodule\n', "utf8");
    expect(() => claimDigest(spec)).toThrow("nowhere.k not found");
  });
});

//////////////////////////////
// The wire shape           //
//////////////////////////////

describe("the cache file's shape", () => {
  test("is {moduleList, digest} with a BARE module list — no KAST envelope", () => {
    // pyk writes `KFlatModuleList.to_dict()` directly (`claim_loader.py:117-121`),
    // unlike every `--emit-json-*` file, which is enveloped.  Keeping that is
    // what makes the file readable by pyk.
    const dict = claimModuleListToDict({ moduleList: MODULE_LIST, digest: "deadbeef" });
    expect(Object.keys(dict).toSorted()).toEqual(["digest", "moduleList"]);
    expect(dict["digest"]).toBe("deadbeef");
    expect(dict["moduleList"]).toMatchObject({ node: "KFlatModuleList", mainModule: "MULTI-CLAIM-SPEC" });
    expect(dict).not.toHaveProperty("format");
  });

  test("round-trips", () => {
    const decoded = claimModuleListFromDict(claimModuleListToDict({ moduleList: MODULE_LIST, digest: "x" }));
    expect(decoded.digest).toBe("x");
    expect(decoded.moduleList.modules.map((module) => module.name)).toEqual(
      MODULE_LIST.modules.map((module) => module.name),
    );
  });

  test("rejects a file that is not the expected shape", () => {
    expect(() => claimModuleListFromDict(null)).toThrow(TypeError);
    expect(() => claimModuleListFromDict([])).toThrow(TypeError);
    expect(() => claimModuleListFromDict({ moduleList: {} })).toThrow(TypeError);
    expect(() => claimModuleListFromDict({ digest: 7, moduleList: {} })).toThrow(TypeError);
  });
});

//////////////////////////////
// The cache decision       //
//////////////////////////////

describe("loadClaims", () => {
  test("a cold run parses, writes the cache, and returns the claims", async () => {
    const spec = await specCopy();
    const parser = recordingParser();
    const claims = await new ClaimLoader(parser).loadClaims(spec);

    expect(parser.calls).toHaveLength(1);
    expect(claims).toHaveLength(10);

    const written = claimModuleListFromDict(JSON.parse(await readFile(claimCacheFile(spec), "utf8")));
    expect(written.digest).toBe(claimDigest(spec));
    expect(written.moduleList.mainModule).toBe("MULTI-CLAIM-SPEC");
  });

  test("a warm run with a matching digest does NOT call the parser", async () => {
    const spec = await specCopy();
    await new ClaimLoader(recordingParser()).loadClaims(spec);

    const second = recordingParser();
    const claims = await new ClaimLoader(second).loadClaims(spec);

    expect(second.calls).toEqual([]);
    expect(claims).toHaveLength(10);
  });

  test("a stale digest calls the parser and rewrites the file", async () => {
    const spec = await specCopy();
    const cache = claimCacheFile(spec);
    await writeFile(
      cache,
      JSON.stringify(claimModuleListToDict({ moduleList: MODULE_LIST, digest: "not-the-digest" })),
      "utf8",
    );

    const parser = recordingParser();
    await new ClaimLoader(parser).loadClaims(spec);

    expect(parser.calls).toHaveLength(1);
    expect(claimModuleListFromDict(JSON.parse(await readFile(cache, "utf8"))).digest).toBe(claimDigest(spec));
  });

  test("editing the spec invalidates a cache that was valid a moment ago", async () => {
    const spec = await specCopy();
    await new ClaimLoader(recordingParser()).loadClaims(spec);

    await writeFile(spec, `${await readFile(spec, "utf8")}\nmodule EXTRA endmodule\n`, "utf8");

    const parser = recordingParser();
    await new ClaimLoader(parser).loadClaims(spec);
    expect(parser.calls).toHaveLength(1);
  });

  test("forwards exactly the four arguments parse_modules takes (claim_loader.py:72-78)", async () => {
    const spec = await specCopy();
    const parser = recordingParser();
    await new ClaimLoader(parser).loadClaims(spec, {
      specModuleName: "MULTI-CLAIM-SPEC",
      includeDirs: ["inc"],
      mdSelector: "k",
      typeInferenceMode: "checked",
      // Not forwarded: these are the index's business, not the parser's.
      claimLabels: ["dep"],
      includeDependencies: false,
    });

    expect(parser.calls[0]?.specFile).toBe(spec);
    expect(parser.calls[0]?.options).toEqual({
      specModuleName: "MULTI-CLAIM-SPEC",
      includeDirs: ["inc"],
      mdSelector: "k",
      typeInferenceMode: "checked",
    });
  });

  test("selects and closes over dependencies, defaulting to closed", async () => {
    const spec = await specCopy();
    const loader = new ClaimLoader(recordingParser());

    const closed = await loader.loadClaims(spec, { claimLabels: ["MULTI-CLAIM-SPEC.main.1"] });
    expect(closed).toHaveLength(3);

    const open = await loader.loadClaims(spec, {
      claimLabels: ["MULTI-CLAIM-SPEC.main.1"],
      includeDependencies: false,
    });
    expect(open).toHaveLength(1);
  });

  test("honours excludeClaimLabels", async () => {
    const spec = await specCopy();
    const loader = new ClaimLoader(recordingParser());
    const claims = await loader.loadClaims(spec, {
      claimLabels: ["MULTI-CLAIM-SPEC.main.1"],
      excludeClaimLabels: ["MULTI-CLAIM-SPEC.dep"],
    });
    expect(claims).toHaveLength(2);
  });

  test("an unresolvable label is a ClaimIndexError, not a silent empty result", async () => {
    const spec = await specCopy();
    const loader = new ClaimLoader(recordingParser());
    await caughtAsync(loader.loadClaims(spec, { claimLabels: ["nope"] }), ClaimIndexError);
  });

  test("logs the five lines upstream logs, in order", async () => {
    const spec = await specCopy();
    const lines: string[] = [];
    await new ClaimLoader(recordingParser(), {
      logger: (message) => {
        lines.push(message);
      },
    }).loadClaims(spec);
    expect(lines[0]).toBe(`Loading spec file: ${spec}`);
    expect(lines[1]).toStartWith("Calculated digest: ");
    expect(lines[2]).toBe("Generating claim modules");
    expect(lines[3]).toBe(`Writing claim file: ${claimCacheFile(spec)}`);
  });

  test("a corrupt cache file is an error, not a silent miss", async () => {
    // Upstream's `json.loads` and `from_dict` are both unguarded
    // (`claim_loader.py:67`); transcribed, because a caller who wrote that file
    // on purpose should hear about it.
    const spec = await specCopy();
    await writeFile(claimCacheFile(spec), "{ not json", "utf8");
    await caughtAsync(new ClaimLoader(recordingParser()).loadClaims(spec), Error);
  });
});
