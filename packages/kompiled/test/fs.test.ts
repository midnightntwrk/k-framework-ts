/**
 * `src/fs.ts` — the I/O shell, and the port of
 * `pyk/src/tests/integration/test_kompile.py`.
 *
 * That file *is* the specification of a kompiled-directory reader, and its
 * assertions carry over one for one: `backend`, `main_module_name == 'IMP'`,
 * `syntax_module_name == 'IMP-SYNTAX'`, `timestamp >= 0`, and the booster
 * layout's `llvm-library/backend.txt == llvm`.  Upstream builds its directory
 * at runtime with `kompile`; ours is vendored (`fixtures/PROVENANCE.md`), so the
 * same assertions run with no K install and no network.
 *
 * The booster case is the one that still needs a directory made at test time —
 * a booster kompilation is two `kompile` runs and nothing in the fixture set is
 * one — so a minimal two-level layout is synthesised in a temp dir.  That is
 * exactly what `test_booster_kompile` does, minus the `kompile`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KompiledDirNotFoundError, MissingKompiledFileError } from "../src/errors.ts";
import { findKompiledDir, loadKompiledDefinition, loadKompiledLayout, LLVM_LIBRARY_DIR } from "../src/fs.ts";
import { caughtAsync } from "./caught.ts";
import { GENERATED, IMP_HASKELL, IMP_LLVM } from "./fixtures.ts";

let scratch: string;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "kframework-ts-kompiled-"));
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/** A directory with just the four required markers — the smallest loadable one. */
async function writeMarkers(dir: string, backend: string, main = "TEST", syntax = "TEST-SYNTAX"): Promise<string> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "mainModule.txt"), main);
  await writeFile(join(dir, "mainSyntaxModule.txt"), syntax);
  await writeFile(join(dir, "backend.txt"), backend);
  await writeFile(join(dir, "timestamp"), Buffer.from([0xac, 0xed, 0x00, 0x05, 0x74, 0x00, 0x00]));
  return dir;
}

describe("test_kompile.py: TestHaskellKompile / TestLlvmKompile", () => {
  test("haskell", async () => {
    const layout = await loadKompiledLayout(IMP_HASKELL);
    expect(layout.backend).toBe("haskell");
    expect(layout.mainModule).toBe("IMP");
    expect(layout.mainSyntaxModule).toBe("IMP-SYNTAX");
    expect(layout.timestampMtimeMs).toBeGreaterThanOrEqual(0);
  });

  test("llvm", async () => {
    const layout = await loadKompiledLayout(IMP_LLVM);
    expect(layout.backend).toBe("llvm");
    expect(layout.mainModule).toBe("IMP");
    expect(layout.mainSyntaxModule).toBe("IMP-SYNTAX");
    expect(layout.timestampMtimeMs).toBeGreaterThanOrEqual(0);
  });

  test("the timestamp mtime comes from stat, and nanoseconds are available too", async () => {
    const layout = await loadKompiledLayout(IMP_HASKELL);
    // pyk reports `st_mtime_ns` (`ktool/kompile.py:667-668`), which no
    // JavaScript `number` can hold; both are exposed and they agree.
    expect(layout.timestampMtimeNs).toBeDefined();
    expect(Number(layout.timestampMtimeNs! / 1_000_000n)).toBe(Math.floor(layout.timestampMtimeMs));
  });
});

describe("test_kompile.py: test_booster_kompile", () => {
  test("the nested llvm-library directory loads with the same functions", async () => {
    // `ktool/kompile.py:109-176` runs kompile twice: haskell at the top and
    // llvm into `<dir>/llvm-library`.  Upstream asserts exactly these two
    // backends (`test_kompile.py:64-65`).
    const dir = join(scratch, "booster");
    await writeMarkers(dir, "haskell");
    await writeMarkers(join(dir, LLVM_LIBRARY_DIR), "llvm");

    expect((await loadKompiledLayout(dir)).backend).toBe("haskell");
    expect((await loadKompiledLayout(join(dir, LLVM_LIBRARY_DIR))).backend).toBe("llvm");
  });

  test("and it does not end in -kompiled, which is why naming is not a contract", () => {
    expect(LLVM_LIBRARY_DIR.endsWith("-kompiled")).toBe(false);
  });
});

describe("error contract", () => {
  test("missing backend.txt names the file and the directory", async () => {
    const dir = join(scratch, "no-backend");
    await writeMarkers(dir, "llvm");
    await rm(join(dir, "backend.txt"));

    const error = await caughtAsync(loadKompiledLayout(dir), MissingKompiledFileError);
    expect(error.file).toBe("backend.txt");
    expect(error.message).toContain("backend.txt");
    expect(error.message).toContain(dir);
  });

  test("missing timestamp is reported as a missing file, not as an ENOENT", async () => {
    const dir = join(scratch, "no-timestamp");
    await writeMarkers(dir, "llvm");
    await rm(join(dir, "timestamp"));

    const error = await caughtAsync(loadKompiledLayout(dir), MissingKompiledFileError);
    expect(error.file).toBe("timestamp");
  });

  test("a directory that does not exist at all still names the first missing marker", async () => {
    const error = await caughtAsync(loadKompiledLayout(join(scratch, "nope")), MissingKompiledFileError);
    expect(error.file).toBe("mainModule.txt");
  });

  test("…and names it on every run: the three reads are raced, so order must be imposed", async () => {
    // The three marker reads run concurrently, and `Promise.all` rejects with
    // whichever *settles* first — which on a directory where all three are
    // missing is a coin toss, and made the assertion above fail on roughly
    // 1.5% of runs.  `Promise.allSettled` plus a scan in array order fixes the
    // reported file to the first of `REQUIRED_MARKERS`.  A hundred iterations
    // put the flake probability at ~1 - 0.985^100, i.e. essentially certain to
    // catch a regression.
    const missing = join(scratch, "nope-repeatedly");
    for (let i = 0; i < 100; i += 1) {
      const error = await caughtAsync(loadKompiledLayout(missing), MissingKompiledFileError);
      expect(error.file).toBe("mainModule.txt");
    }
  });

  test("with only the last marker present, the first missing one is still the one named", async () => {
    const dir = join(scratch, "backend-only");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "backend.txt"), "llvm");
    for (let i = 0; i < 20; i += 1) {
      expect((await caughtAsync(loadKompiledLayout(dir), MissingKompiledFileError)).file).toBe("mainModule.txt");
    }
  });
});

describe("optional artifacts", () => {
  test("a directory with only markers loads; the artifacts fail on use, not on load", async () => {
    const dir = join(scratch, "markers-only");
    await writeMarkers(dir, "kore");
    const kompiled = await loadKompiledDefinition(dir);

    expect(kompiled.layout.backend).toBe("kore");
    expect(kompiled.layout.allRules.size).toBe(0);
    expect(kompiled.layout.configVars).toEqual([]);
    expect(kompiled.layout.hasConfigVarsFile).toBe(false);
    expect(kompiled.text("definition.kore")).toBeUndefined();
  });

  test("hasConfigVarsFile records the file's presence, not its contents", async () => {
    // The real fixture has one; a markers-only directory does not; and a
    // directory with a zero-byte `configVars.sh` has one that says nothing.
    expect((await loadKompiledLayout(IMP_HASKELL)).hasConfigVarsFile).toBe(true);

    const dir = join(scratch, "empty-configvars");
    await writeMarkers(dir, "llvm");
    await writeFile(join(dir, "configVars.sh"), "");
    const layout = await loadKompiledLayout(dir);
    expect(layout.hasConfigVarsFile).toBe(true);
    expect(layout.configVars).toEqual([]);
  });
});

describe("findKompiledDir", () => {
  test("exactly one match — Kompile.default_directory (ktool/kompile.py:228)", async () => {
    const dir = join(scratch, "one");
    await mkdir(join(dir, "foo-kompiled"), { recursive: true });
    expect(await findKompiledDir(dir)).toBe(join(dir, "foo-kompiled"));
  });

  test("no match — pyk's wording, and the fix in the message", async () => {
    const dir = join(scratch, "none");
    await mkdir(dir, { recursive: true });
    const error = await caughtAsync(findKompiledDir(dir), KompiledDirNotFoundError);
    expect(error.message).toContain("Could not find `*-kompiled` directory");
    expect(error.message).toContain("--definition");
    expect(error.candidates).toEqual([]);
  });

  test("two matches — named, and sorted so the message is stable", async () => {
    const dir = join(scratch, "two");
    await mkdir(join(dir, "b-kompiled"), { recursive: true });
    await mkdir(join(dir, "a-kompiled"), { recursive: true });
    const error = await caughtAsync(findKompiledDir(dir), KompiledDirNotFoundError);
    expect(error.candidates).toEqual(["a-kompiled", "b-kompiled"]);
    expect(error.message).toContain("a-kompiled, b-kompiled");
  });

  test("a *file* named `x-kompiled` is not a match — pyk's glob would take it", async () => {
    const dir = join(scratch, "file-not-dir");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "x-kompiled"), "");
    const error = await caughtAsync(findKompiledDir(dir), KompiledDirNotFoundError);
    expect(error.candidates).toEqual([]);
  });

  test("a SYMLINK to a directory is a match — readdir's dirents are lstat-shaped", async () => {
    // `withFileTypes` reports a symlink as `isSymbolicLink()` with
    // `isDirectory() === false` however ordinary its target, so a bare
    // `isDirectory()` test misses `foo-kompiled -> ../build/foo-kompiled`.
    // pyk's `Path.is_dir()` follows links, and so must this.
    const dir = join(scratch, "symlinked");
    const target = join(scratch, "symlink-target");
    await mkdir(target, { recursive: true });
    await mkdir(dir, { recursive: true });
    await symlink(target, join(dir, "linked-kompiled"), "dir");

    expect(await findKompiledDir(dir)).toBe(join(dir, "linked-kompiled"));
  });

  test("a symlink to a FILE is not a match, and neither is a dangling one", async () => {
    // The follow-up `stat` is what makes the link's *target* decide, so the
    // two cases that a bare `isSymbolicLink()` would wrongly accept are
    // rejected here.
    const dir = join(scratch, "symlink-not-dir");
    await mkdir(dir, { recursive: true });
    await writeFile(join(scratch, "some-file"), "");
    await symlink(join(scratch, "some-file"), join(dir, "tofile-kompiled"));
    await symlink(join(scratch, "does-not-exist"), join(dir, "dangling-kompiled"));

    expect((await caughtAsync(findKompiledDir(dir), KompiledDirNotFoundError)).candidates).toEqual([]);
  });

  test("finds both fixture directories, which is not one — so it refuses", async () => {
    // `fixtures/generated/` holds both IMP backends on purpose; the refusal is
    // the right answer and is what `--definition` exists for.  Sorted, because
    // `readdir` order is not a contract.
    //
    // `packages/wasm-fixtures` owns the KWasm artifact. The `krun` directories
    // beside these are not candidates, so the "more than one" case remains.
    const error = await caughtAsync(findKompiledDir(GENERATED), KompiledDirNotFoundError);
    expect(error.candidates.toSorted()).toEqual(["imp-haskell-kompiled", "imp-llvm-kompiled"]);
  });
});
