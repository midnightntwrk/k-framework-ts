/**
 * `src/kompile.ts`'s non-argv semantics: the dynamic door
 * (`kompileFromDict`), the two directory helpers, and the two things
 * `kompile()` guarantees **before** it creates a process.
 *
 * No K binary is involved anywhere in this file.  The `kompile()` cases all
 * stop at a precondition, which is the property being tested: a missing
 * `kompile` is reported as `KompileNotFoundError` rather than as a fork that
 * fails, and a missing main file is reported before either.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { KompiledDirNotFoundError } from "@kframework-ts/kompiled";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { caught, caughtAsync } from "./caught.ts";
import {
  backendArgKeys,
  COMMON_ARG_KEYS,
  defaultDirectory,
  defaultOutputDir,
  HASKELL_ARG_KEYS,
  isKompileBackend,
  kompile,
  kompileDetailed,
  KompileArgumentError,
  KompileNotFoundError,
  kompileFromDict,
  KOMPILE_BACKENDS,
  LLVM_ARG_KEYS,
  LLVM_KOMPILE_TYPES,
  PYK_BACKENDS,
  TYPE_INFERENCE_MODES,
  WARNINGS,
  boosterKompile,
} from "../src/kompile.ts";

const scratchDirs: string[] = [];

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ktool-kompile-"));
  scratchDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

//////////////////////////////
// Enumerations             //
//////////////////////////////

describe("the enumerations", () => {
  test("carry exactly upstream's members", () => {
    expect(TYPE_INFERENCE_MODES).toEqual(["z3", "simplesub", "checked", "default"]);
    expect(KOMPILE_BACKENDS).toEqual(["llvm", "haskell", "kore", "maude"]);
    expect(PYK_BACKENDS).toEqual(["llvm", "haskell", "kore", "maude", "booster"]);
    expect(WARNINGS).toEqual(["all", "normal", "none"]);
    expect(LLVM_KOMPILE_TYPES).toEqual(["main", "search", "library", "static", "python", "c"]);
  });

  test("PykBackend is KompileBackend plus booster (`:35-40`)", () => {
    expect(PYK_BACKENDS.slice(0, 4)).toEqual([...KOMPILE_BACKENDS]);
  });

  test("isKompileBackend accepts only the four names", () => {
    expect(isKompileBackend("llvm")).toBe(true);
    expect(isKompileBackend("booster")).toBe(false);
    expect(isKompileBackend(7)).toBe(false);
    expect(isKompileBackend(undefined)).toBe(false);
  });
});

describe("the key inventories", () => {
  test("COMMON_ARG_KEYS is the sixteen KompileArgs fields (`:640`)", () => {
    expect(COMMON_ARG_KEYS).toHaveLength(16);
    expect(new Set(COMMON_ARG_KEYS).size).toBe(16);
  });

  test("no key belongs to two inventories", () => {
    const all = [...COMMON_ARG_KEYS, ...LLVM_ARG_KEYS, ...HASKELL_ARG_KEYS];
    expect(new Set(all).size).toBe(all.length);
  });

  test("maude claims no backend keys, and kore claims none either", () => {
    expect(backendArgKeys("maude")).toEqual([]);
    expect(backendArgKeys("kore")).toEqual([]);
    expect(backendArgKeys("llvm")).toEqual([...LLVM_ARG_KEYS]);
    expect(backendArgKeys("haskell")).toEqual([...HASKELL_ARG_KEYS]);
  });
});

//////////////////////////////
// kompileFromDict          //
//////////////////////////////

describe("kompileFromDict — Kompile.from_dict (`:241-266`)", () => {
  test("defaults the backend to llvm", () => {
    expect(kompileFromDict({ mainFile: "imp.k" })).toEqual({ backend: "llvm", mainFile: "imp.k" });
  });

  test("a nullish or empty backend also defaults to llvm (`dct.get('backend') or 'llvm'`)", () => {
    expect(kompileFromDict({ mainFile: "imp.k", backend: undefined }).backend).toBe("llvm");
    expect(kompileFromDict({ mainFile: "imp.k", backend: null }).backend).toBe("llvm");
    expect(kompileFromDict({ mainFile: "imp.k", backend: "" }).backend).toBe("llvm");
  });

  test("keeps common and backend keys, in whatever order they arrived", () => {
    expect(kompileFromDict({ backend: "haskell", mainFile: "imp.k", concreteRules: ["a"], mainModule: "IMP" })).toEqual(
      { backend: "haskell", mainFile: "imp.k", concreteRules: ["a"], mainModule: "IMP" },
    );
  });

  test("an unknown key raises, naming the backend and the key (`:255`)", () => {
    const error = caught(
      () => kompileFromDict({ mainFile: "imp.k", backend: "haskell", optLevel: 2 }),
      KompileArgumentError,
    );
    // `optLevel` is a real option — of the *other* backend.  That is the case
    // the check exists for, and the one `_booster_kompile` swallows.
    expect(error.message).toContain("haskell");
    expect(error.message).toContain("optLevel");
  });

  test("a misspelled key raises rather than being ignored", () => {
    expect(() => kompileFromDict({ mainFile: "imp.k", emit_json: true })).toThrow(KompileArgumentError);
    expect(() => kompileFromDict({ mainFile: "imp.k", emitJSON: true })).toThrow(KompileArgumentError);
  });

  test("pyk's snake_case spelling is not a second accepted name", () => {
    // Accepting both would make `emit_json` and `emitJson` two ways to set one
    // flag, and neither of them the documented one.
    expect(() => kompileFromDict({ main_file: "imp.k" })).toThrow(KompileArgumentError);
  });

  test("maude accepts every common key and no backend key", () => {
    expect(kompileFromDict({ backend: "maude", mainFile: "imp.k", coverage: true })).toEqual({
      backend: "maude",
      mainFile: "imp.k",
      coverage: true,
    });
    expect(() => kompileFromDict({ backend: "maude", mainFile: "imp.k", concreteRules: [] })).toThrow(
      KompileArgumentError,
    );
    expect(() => kompileFromDict({ backend: "maude", mainFile: "imp.k", optLevel: 1 })).toThrow(KompileArgumentError);
  });

  test("the kore backend is rejected (`:265-266`)", () => {
    // `KompileBackend` has `kore`, but `from_dict`'s match has no arm for it,
    // so a kore spec has never been constructible upstream either.
    const error = caught(() => kompileFromDict({ backend: "kore", mainFile: "imp.k" }), KompileArgumentError);
    expect(error.message).toBe("Unsupported backend: kore");
  });

  test("booster is not a backend here — it is boosterKompile", () => {
    expect(() => kompileFromDict({ backend: "booster", mainFile: "imp.k" })).toThrow(KompileArgumentError);
  });

  test("an unknown backend name is rejected", () => {
    expect(() => kompileFromDict({ backend: "wasm", mainFile: "imp.k" })).toThrow(KompileArgumentError);
    expect(() => kompileFromDict({ backend: 7, mainFile: "imp.k" })).toThrow(KompileArgumentError);
  });

  test("mainFile is required", () => {
    expect(() => kompileFromDict({})).toThrow(KompileArgumentError);
    expect(() => kompileFromDict({ mainModule: "IMP" })).toThrow(KompileArgumentError);
  });

  test("values are type-checked, which pyk's dataclasses do not do", () => {
    // Added on top of upstream: a number where a string belongs would otherwise
    // reach `str.join` or, worse, silently become a flag value.
    expect(() => kompileFromDict({ mainFile: 7 })).toThrow(KompileArgumentError);
    expect(() => kompileFromDict({ mainFile: "imp.k", includeDirs: "a" })).toThrow(KompileArgumentError);
    expect(() => kompileFromDict({ mainFile: "imp.k", includeDirs: [1] })).toThrow(KompileArgumentError);
    expect(() => kompileFromDict({ mainFile: "imp.k", emitJson: "yes" })).toThrow(KompileArgumentError);
    expect(() => kompileFromDict({ mainFile: "imp.k", optLevel: "2" })).toThrow(KompileArgumentError);
    expect(() => kompileFromDict({ mainFile: "imp.k", llvmKompileType: "nonsense" })).toThrow(KompileArgumentError);
  });
});

//////////////////////////////
// Output directories       //
//////////////////////////////

describe("defaultOutputDir — `_default_output_dir` (`:356-357`)", () => {
  test("is `<stem>-kompiled`, and relative", () => {
    expect(defaultOutputDir("imp.k")).toBe("imp-kompiled");
    expect(defaultOutputDir("imp.md")).toBe("imp-kompiled");
    expect(defaultOutputDir("imp")).toBe("imp-kompiled");
  });

  test("drops the directory — the trap the quirk ledger shouts about", () => {
    // The result is relative to the *process* working directory, not to the
    // main file's directory and not to `cwd:`.
    expect(defaultOutputDir("semantics/deep/imp.k")).toBe("imp-kompiled");
    expect(defaultOutputDir("/abs/path/imp.k")).toBe("imp-kompiled");
  });

  test("only the last suffix is removed, and a dotfile keeps its dot", () => {
    expect(defaultOutputDir("a.b.k")).toBe("a.b-kompiled");
    expect(defaultOutputDir(".hidden")).toBe(".hidden-kompiled");
  });
});

describe("defaultDirectory — `Kompile.default_directory` (`:228-239`)", () => {
  test("finds the one *-kompiled directory", async () => {
    const dir = await scratch();
    await mkdir(join(dir, "imp-kompiled"));
    expect(await defaultDirectory(dir)).toBe(join(dir, "imp-kompiled"));
  });

  test("with none, the error says to pass --definition and carries no candidates", async () => {
    const dir = await scratch();
    await mkdir(join(dir, "not-a-match"));
    await writeFile(join(dir, "imp.k"), "");
    const error = await caughtAsync(defaultDirectory(dir), KompiledDirNotFoundError);
    expect(error.candidates).toEqual([]);
    expect(error.message).toContain("Could not find");
    expect(error.message).toContain("--definition");
  });

  test("with several, the error is a different one and names two of them", async () => {
    // `single()` raises with a one-element `args` for none and a three-element
    // one for many (`utils.py:293,298`); pyk turns that into two messages, and
    // `candidates` makes the distinction checkable without reading either.
    const dir = await scratch();
    for (const name of ["a-kompiled", "b-kompiled", "c-kompiled"]) await mkdir(join(dir, name));
    const error = await caughtAsync(defaultDirectory(dir), KompiledDirNotFoundError);
    expect(error.candidates).toEqual(["a-kompiled", "b-kompiled", "c-kompiled"]);
    expect(error.message).toContain("More than one");
  });

  test("a *file* named *-kompiled is not a candidate", async () => {
    const dir = await scratch();
    await writeFile(join(dir, "decoy-kompiled"), "");
    await mkdir(join(dir, "real-kompiled"));
    expect(await defaultDirectory(dir)).toBe(join(dir, "real-kompiled"));
  });
});

//////////////////////////////
// Preconditions            //
//////////////////////////////

describe("kompile() stops before spawning", () => {
  /** A scratch directory holding a real (empty) `imp.k`. */
  async function withMainFile(): Promise<{ dir: string; mainFile: string }> {
    const dir = await scratch();
    const mainFile = join(dir, "imp.k");
    await writeFile(mainFile, "module IMP endmodule\n");
    return { dir, mainFile };
  }

  test("KompileNotFoundError when PATH is empty (`:296-298`)", async () => {
    const { mainFile } = await withMainFile();
    const error = await caughtAsync(
      kompile({ backend: "llvm", mainFile }, { env: { PATH: "" } }),
      KompileNotFoundError,
    );
    expect(error.command).toBe("kompile");
    expect(error.message).toBe("Kompile command not found: kompile");
  });

  test("KompileNotFoundError for a command name that cannot exist", async () => {
    const { mainFile } = await withMainFile();
    const error = await caughtAsync(
      kompile({ backend: "llvm", mainFile }, { command: ["ktool-no-such-kompile-4b7c"] }),
      KompileNotFoundError,
    );
    expect(error.command).toBe("ktool-no-such-kompile-4b7c");
  });

  test("a missing main file is reported before the PATH lookup (`:292`)", async () => {
    const dir = await scratch();
    const error = await caughtAsync(
      kompile({ backend: "llvm", mainFile: join(dir, "absent.k") }, { env: { PATH: "" } }),
      Error,
    );
    // Not a KompileNotFoundError: the order of the two checks is upstream's.
    expect(error).not.toBeInstanceOf(KompileNotFoundError);
    expect(error.message).toContain("File does not exist");
  });

  test("a missing include directory is reported too (`:293-294`)", async () => {
    const { dir, mainFile } = await withMainFile();
    const error = await caughtAsync(
      kompile({ backend: "llvm", mainFile, includeDirs: [join(dir, "absent")] }, { env: { PATH: "" } }),
      Error,
    );
    expect(error).not.toBeInstanceOf(KompileNotFoundError);
    expect(error.message).toContain("Directory does not exist");
  });

  test("relative paths are resolved against `cwd`, not the process's (`abs_or_rel_to`)", async () => {
    const { dir } = await withMainFile();
    // `imp.k` does not exist relative to this test's working directory; it does
    // relative to `cwd`, so the run gets as far as the PATH lookup.
    await caughtAsync(
      kompile({ backend: "llvm", mainFile: "imp.k" }, { cwd: dir, env: { PATH: "" } }),
      KompileNotFoundError,
    );
  });

  test("an empty command is an argument error, not a not-found", async () => {
    const { mainFile } = await withMainFile();
    await caughtAsync(kompile({ backend: "llvm", mainFile }, { command: [] }), KompileArgumentError);
  });
});

describe("kompileDetailed", () => {
  async function fakeKompile(): Promise<{ command: string; mainFile: string; dir: string }> {
    const dir = await scratch();
    const command = join(dir, "kompile");
    const mainFile = join(dir, "imp.k");
    await writeFile(mainFile, "module IMP endmodule\n");
    await writeFile(
      command,
      `#!/bin/bash
if [[ "\${KTOOL_FAKE_EXIT:-0}" != 0 ]]; then
  echo "fake failure" >&2
  exit "\${KTOOL_FAKE_EXIT}"
fi
output=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "--output-definition" ]]; then output="$2"; shift 2; else shift; fi
done
/bin/mkdir -p "$output"
echo "fake stdout"
echo "successful stderr" >&2
`,
    );
    await chmod(command, 0o755);
    return { command, mainFile, dir };
  }

  test("returns the definition directory and complete process record while kompile() remains the projection", async () => {
    const fixture = await fakeKompile();
    const detailedOutput = join(fixture.dir, "detailed-output");
    const detailed = await kompileDetailed(
      { backend: "llvm", mainFile: fixture.mainFile },
      { command: [fixture.command], outputDir: detailedOutput, env: { PATH: "" } },
    );
    expect(detailed.definitionDir).toBe(detailedOutput);
    expect(detailed.definitionDirExists).toBe(true);
    expect(detailed.process.returncode).toBe(0);
    expect(detailed.process.stdout).toBe("fake stdout\n");
    expect(detailed.process.stderr).toBe("successful stderr\n");
    expect(detailed.process.args).toContain("--output-definition");

    const projectedOutput = join(fixture.dir, "projected-output");
    expect(
      await kompile(
        { backend: "llvm", mainFile: fixture.mainFile },
        { command: [fixture.command], outputDir: projectedOutput, env: { PATH: "" } },
      ),
    ).toBe(projectedOutput);
  });

  test("check:false preserves a failed CompletedProcess even when no definition directory exists", async () => {
    const fixture = await fakeKompile();
    const outputDir = join(fixture.dir, "missing-output");
    const detailed = await kompileDetailed(
      { backend: "llvm", mainFile: fixture.mainFile },
      {
        command: [fixture.command],
        outputDir,
        check: false,
        env: { PATH: "", KTOOL_FAKE_EXIT: "7" },
      },
    );
    expect(detailed.definitionDir).toBe(outputDir);
    expect(detailed.definitionDirExists).toBe(false);
    expect(detailed.process.returncode).toBe(7);
    expect(detailed.process.stderr).toBe("fake failure\n");

    expect(
      kompile(
        { backend: "llvm", mainFile: fixture.mainFile },
        {
          command: [fixture.command],
          outputDir,
          check: false,
          env: { PATH: "", KTOOL_FAKE_EXIT: "7" },
        },
      ),
    ).rejects.toThrow("is not a directory");
  });
});

describe("boosterKompile", () => {
  test("rejects an llvmKompileType other than 'c' (`:128-129`)", async () => {
    const dir = await scratch();
    const mainFile = join(dir, "imp.k");
    await writeFile(mainFile, "");
    const error = await caughtAsync(
      boosterKompile({ mainFile, llvmKompileType: "library" }, { env: { PATH: "" } }),
      KompileArgumentError,
    );
    expect(error.message).toContain("llvmKompileType");
    expect(error.message).toContain("library");
  });

  test("throws on an unknown key, where `_group_args` silently drops it (`:185-198`)", async () => {
    const dir = await scratch();
    const mainFile = join(dir, "imp.k");
    await writeFile(mainFile, "");
    const error = await caughtAsync(
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      boosterKompile({ mainFile, notAnOption: true } as unknown as { mainFile: string }, { env: { PATH: "" } }),
      KompileArgumentError,
    );
    expect(error.message).toContain("notAnOption");
  });

  test("both halves stop at the PATH lookup, so neither spawns", async () => {
    const dir = await scratch();
    const mainFile = join(dir, "imp.k");
    await writeFile(mainFile, "");
    await caughtAsync(
      boosterKompile(
        { mainFile, optLevel: 2, concreteRules: ["r"] },
        { env: { PATH: "" }, outputDir: join(dir, "out") },
      ),
      KompileNotFoundError,
    );
  });
});
