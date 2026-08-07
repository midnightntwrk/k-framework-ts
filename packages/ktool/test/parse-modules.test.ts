/**
 * `src/parse-modules.ts`'s pure halves: the argv table and the decoder.
 *
 * `_kprove`/`_build_arg_list` have **no unit test upstream** — the only ktool
 * argv goldens pyk ships are `PYKT/unit/ktool/test_krun.py`'s.  This file is
 * therefore a new table, written by reading `kprove.py:104-155` line by line;
 * every row names the upstream line it pins.
 *
 * Nothing here starts a process.  `parseModules` itself is exercised only for
 * its two pre-spawn preconditions, which fail before `spawn` is reached.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "bun:test";

import { caughtAsync } from "./caught.ts";
import {
  buildKproveArgv,
  buildKproveTypedArgs,
  decodeModuleList,
  KPROVE_OUTPUTS,
  kproveParseModulesArgs,
  parseModules,
} from "../src/parse-modules.ts";

const scratchDirs: string[] = [];

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ktool-parse-modules-test-"));
  scratchDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

//////////////////////////////
// The enumeration          //
//////////////////////////////

test("KProveOutput carries exactly upstream's members (kprove.py:38-46)", () => {
  expect(KPROVE_OUTPUTS).toEqual(["pretty", "program", "KAST", "binary", "json", "latex", "kore", "none"]);
});

//////////////////////////////
// _build_arg_list          //
//////////////////////////////

describe("buildKproveTypedArgs", () => {
  test("emits nothing for an empty argument set", () => {
    expect(buildKproveTypedArgs({})).toEqual([]);
  });

  test("emits every flag in _build_arg_list's order (kprove.py:120-153)", () => {
    expect(
      buildKproveTypedArgs({
        definitionDir: "defn",
        specModuleName: "SPEC",
        mdSelector: "k & ! nope",
        includeDirs: ["one", "two"],
        emitJsonSpec: "out.json",
        output: "json",
        claims: ["a", "b"],
        typeInferenceMode: "checked",
        tempDir: "tmp",
        haskellBackendCommand: "kore-exec",
        depth: 3,
        dryRun: true,
      }),
    ).toEqual([
      "--definition",
      "defn",
      "--spec-module",
      "SPEC",
      "--md-selector",
      "k & ! nope",
      "-I",
      "one",
      "-I",
      "two",
      "--emit-json-spec",
      "out.json",
      "--output",
      "json",
      "--claims",
      "a,b",
      "--type-inference-mode",
      "checked",
      "--temp-dir",
      "tmp",
      "--haskell-backend-command",
      "kore-exec",
      "--depth",
      "3",
      "--dry-run",
    ]);
  });

  test("repeats -I once per include directory, in order (kprove.py:127-128)", () => {
    expect(buildKproveTypedArgs({ includeDirs: ["a", "b", "c"] })).toEqual(["-I", "a", "-I", "b", "-I", "c"]);
    expect(buildKproveTypedArgs({ includeDirs: [] })).toEqual([]);
  });

  test("comma-joins --claims, and emits nothing for an empty list (kprove.py:136-137)", () => {
    expect(buildKproveTypedArgs({ claims: ["x"] })).toEqual(["--claims", "x"]);
    expect(buildKproveTypedArgs({ claims: [] })).toEqual([]);
  });

  test("dryRun false emits nothing (kprove.py:152-153)", () => {
    expect(buildKproveTypedArgs({ dryRun: false })).toEqual([]);
  });

  describe("--depth uses `if depth:`, unlike krun (kprove.py:149)", () => {
    test("a positive depth is emitted", () => {
      expect(buildKproveTypedArgs({ depth: 1 })).toEqual(["--depth", "1"]);
      expect(buildKproveTypedArgs({ depth: 42 })).toEqual(["--depth", "42"]);
    });

    test("depth 0 is NOT emitted — this is the divergence from krun", () => {
      // `krun`'s builder writes `if depth is not None:` and emits `--depth 0`.
      // Same field name, opposite behaviour; both are upstream's and both are
      // transcribed as written (`kprove.py:149` vs `krun.py:400`).
      expect(buildKproveTypedArgs({ depth: 0 })).toEqual([]);
    });

    test("an omitted depth is not emitted either", () => {
      expect(buildKproveTypedArgs({})).toEqual([]);
    });
  });

  test("an empty string is falsy upstream and emits nothing", () => {
    // `if kompiled_dir:` etc. — Python truthiness, not `is not None`.
    expect(buildKproveTypedArgs({ definitionDir: "", specModuleName: "", mdSelector: "", tempDir: "" })).toEqual([]);
  });
});

describe("buildKproveArgv", () => {
  test("is command + spec + typed args + the free-form tail (kprove.py:112-116)", () => {
    expect(buildKproveArgv("spec.k", { output: "kore" }, ["--extra"], ["kprove"])).toEqual([
      "kprove",
      "spec.k",
      "--output",
      "kore",
      "--extra",
    ]);
  });

  test("defaults the command to a bare kprove (kprove.py:90)", () => {
    expect(buildKproveArgv("spec.k")).toEqual(["kprove", "spec.k"]);
  });

  test("keeps a multi-word command as separate argv elements", () => {
    expect(buildKproveArgv("spec.k", {}, [], ["nix", "run", ".#kprove", "--"])).toEqual([
      "nix",
      "run",
      ".#kprove",
      "--",
      "spec.k",
    ]);
  });
});

//////////////////////////////
// parse_modules's argv     //
//////////////////////////////

describe("kproveParseModulesArgs", () => {
  test("is exactly what KProve.parse_modules runs (kprove.py:262-275)", () => {
    expect(kproveParseModulesArgs("spec.k", "/tmp/emit.json", { definitionDir: "defn" })).toEqual([
      "kprove",
      "spec.k",
      "--definition",
      "defn",
      "--output",
      "json",
      "--dry-run",
      "--emit-json-spec",
      "/tmp/emit.json",
      "--allow-rules",
    ]);
  });

  test("puts --emit-json-spec AFTER --dry-run, not in its _build_arg_list slot", () => {
    // `parse_modules` passes `emit_json_spec=None` to the typed builder and the
    // flag in the free-form `args` tail instead, so it lands last.  A port that
    // "tidied" this into the typed slot would produce a different argv.
    const argv = kproveParseModulesArgs("spec.k", "emit.json", { definitionDir: "defn" });
    expect(argv.indexOf("--emit-json-spec")).toBeGreaterThan(argv.indexOf("--dry-run"));
    expect(argv.at(-1)).toBe("--allow-rules");
  });

  test("threads every optional through in _build_arg_list's order", () => {
    expect(
      kproveParseModulesArgs("spec.k", "emit.json", {
        definitionDir: "defn",
        specModuleName: "MY-SPEC",
        includeDirs: ["inc"],
        mdSelector: "k",
        typeInferenceMode: "checked",
        tempDir: "tmp",
      }),
    ).toEqual([
      "kprove",
      "spec.k",
      "--definition",
      "defn",
      "--spec-module",
      "MY-SPEC",
      "--md-selector",
      "k",
      "-I",
      "inc",
      "--output",
      "json",
      "--type-inference-mode",
      "checked",
      "--temp-dir",
      "tmp",
      "--dry-run",
      "--emit-json-spec",
      "emit.json",
      "--allow-rules",
    ]);
  });

  test("never emits --depth or --claims — parse_modules passes neither", () => {
    const argv = kproveParseModulesArgs("spec.k", "emit.json", { definitionDir: "defn", tempDir: "tmp" });
    expect(argv).not.toContain("--depth");
    expect(argv).not.toContain("--claims");
    expect(argv).not.toContain("--haskell-backend-command");
  });

  test("honours a configured command", () => {
    expect(
      kproveParseModulesArgs("spec.k", "emit.json", { definitionDir: "defn", command: ["/opt/k/bin/kprove"] }).at(0),
    ).toBe("/opt/k/bin/kprove");
  });
});

//////////////////////////////
// Decoding                 //
//////////////////////////////

describe("decodeModuleList", () => {
  const fixture = join(import.meta.dir, "..", "fixtures", "generated", "multi-claim-spec.modulelist.json");

  test("reads a real --emit-json-spec file through the KAST envelope", () => {
    const list = decodeModuleList(readFileSync(fixture, "utf8"));
    expect(list.node).toBe("KFlatModuleList");
    expect(list.mainModule).toBe("MULTI-CLAIM-SPEC");
    expect(list.modules).toHaveLength(3);
  });

  test("refuses bytes that are not a KAST envelope", () => {
    expect(() => decodeModuleList("{}")).toThrow("Not a readable KAST document");
    expect(() => decodeModuleList("not json")).toThrow("Not a readable KAST document");
    expect(() => decodeModuleList(JSON.stringify({ format: "KORE", version: 1, term: {} }))).toThrow(
      "Not a readable KAST document",
    );
  });

  test("refuses an envelope whose term is not a module list", () => {
    expect(() => decodeModuleList(JSON.stringify({ format: "KAST", version: 4, term: { node: "KSort" } }))).toThrow();
  });
});

//////////////////////////////
// Preconditions            //
//////////////////////////////

describe("parseModules preconditions", () => {
  test("forwards all process controls to the runner", async () => {
    const dir = await scratch();
    const spec = join(dir, "spec.k");
    await writeFile(spec, "module M endmodule\n", "utf8");
    const calls: {
      readonly timeoutMs: number | undefined;
      readonly killGraceMs: number | undefined;
      readonly signal: AbortSignal | undefined;
    }[] = [];
    const signal = new AbortController().signal;
    await parseModules(
      spec,
      { definitionDir: dir },
      {
        timeoutMs: 17,
        killGraceMs: 3,
        signal,
        runner: async (argv, options) => {
          calls.push({ timeoutMs: options.timeoutMs, killGraceMs: options.killGraceMs, signal: options.signal });
          const output = argv[argv.indexOf("--emit-json-spec") + 1];
          if (output === undefined) throw new Error("missing --emit-json-spec output");
          await writeFile(
            output,
            readFileSync(join(import.meta.dir, "../fixtures/generated/multi-claim-spec.modulelist.json"), "utf8"),
          );
          return { args: argv, returncode: 0, stdout: "", stderr: "", signal: undefined };
        },
      },
    );
    expect(calls).toEqual([{ timeoutMs: 17, killGraceMs: 3, signal }]);
  });

  // `check_file_path` / `check_dir_path` before any spawn (`kprove.py:107-110`)
  // — a missing input must not be reported as a process failure.
  test("a missing spec file is reported before a process is created", async () => {
    const dir = await scratch();
    const error = await caughtAsync(parseModules(join(dir, "nope.k"), { definitionDir: dir }), Error);
    expect(error.message).toContain("File does not exist");
  });

  test("a spec path that is a directory is refused", async () => {
    const dir = await scratch();
    const error = await caughtAsync(parseModules(dir, { definitionDir: dir }), Error);
    expect(error.message).toContain("Path is not a file");
  });

  test("a missing include directory is refused", async () => {
    const dir = await scratch();
    const spec = join(dir, "spec.k");
    await writeFile(spec, "module M endmodule\n", "utf8");
    const error = await caughtAsync(
      parseModules(spec, { definitionDir: dir, includeDirs: [join(dir, "missing")] }),
      Error,
    );
    expect(error.message).toContain("Directory does not exist");
  });
});
