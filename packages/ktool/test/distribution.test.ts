/**
 * `src/distribution.ts` — PATH resolution, the install-prefix rule, and the
 * version parser.
 *
 * The version parser is pure, so it is tested as a table.  PATH resolution is
 * tested against a scratch directory holding files this test creates: no K is
 * involved, and neither is the machine's real `PATH` except in the one test
 * that checks the memo does not fabricate an answer.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { caught, caughtAsync } from "./caught.ts";
import {
  clearKDistributionCache,
  getKDistribution,
  kDistributionFrom,
  KVersionParseError,
  kVersion,
  parseKVersion,
  resolveOnPath,
} from "../src/distribution.ts";

const scratchDirs: string[] = [];

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ktool-dist-"));
  scratchDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  clearKDistributionCache();
});

/** A fake K install: `<prefix>/bin/<name>`, executable, running `script`. */
async function fakeBin(prefix: string, name: string, script: string): Promise<string> {
  const bin = join(prefix, "bin");
  await mkdir(bin, { recursive: true });
  const path = join(bin, name);
  await writeFile(path, `#!/usr/bin/env bash\n${script}\n`);
  await chmod(path, 0o755);
  return path;
}

//////////////////////////////
// PATH resolution          //
//////////////////////////////

describe("resolveOnPath", () => {
  test("returns the first PATH entry holding an executable of that name", async () => {
    const first = await scratch();
    const second = await scratch();
    await fakeBin(second, "kompile", "true");
    const wanted = await fakeBin(first, "kompile", "true");

    const path = [join(first, "bin"), join(second, "bin")].join(delimiter);
    expect(await resolveOnPath("kompile", path)).toBe(wanted);
    // Reversing the entries picks the other one — the search really is ordered.
    expect(await resolveOnPath("kompile", [join(second, "bin"), join(first, "bin")].join(delimiter))).toBe(
      join(second, "bin", "kompile"),
    );
  });

  test("skips a file that exists but is not executable", async () => {
    const dir = await scratch();
    await writeFile(join(dir, "kompile"), "not executable");
    await chmod(join(dir, "kompile"), 0o644);
    expect(await resolveOnPath("kompile", dir)).toBeUndefined();
  });

  test("skips a directory of the right name", async () => {
    const dir = await scratch();
    await mkdir(join(dir, "kompile"));
    expect(await resolveOnPath("kompile", dir)).toBeUndefined();
  });

  test("an empty PATH finds nothing — the cheap way to prove a caller checks first", async () => {
    // `""` searches nowhere.  Note that `undefined` does *not*: it is the
    // parameter's default and means `process.env.PATH`, so a test that wants
    // "search nothing" must say `""`.
    expect(await resolveOnPath("kompile", "")).toBeUndefined();
  });

  test("an empty PATH *entry* is skipped, not read as the current directory", async () => {
    // A POSIX shell reads `::` as `.`; `shutil.which` does not, and a tool that
    // silently ran `./kompile` because of a stray colon would be a problem.
    const dir = await scratch();
    await fakeBin(dir, "kompile", "true");
    expect(await resolveOnPath("kompile", `${delimiter}${delimiter}`)).toBeUndefined();
  });

  test("a name containing a separator is used as given, not searched for", async () => {
    const dir = await scratch();
    const bin = await fakeBin(dir, "kompile", "true");
    expect(await resolveOnPath(bin, "")).toBe(bin);
    expect(await resolveOnPath(join(dir, "bin", "absent"), "")).toBeUndefined();
  });

  test("an empty name resolves to nothing", async () => {
    expect(await resolveOnPath("", process.env["PATH"])).toBeUndefined();
  });
});

//////////////////////////////
// The distribution         //
//////////////////////////////

describe("kDistributionFrom", () => {
  test("the prefix is the binary's grandparent, and builtinDir hangs off it", () => {
    // `KDistribution(kompile_bin.parents[1])` and
    // `self.path / 'include/kframework/builtin'` (`ktool/utils.py:25-34`).
    expect(kDistributionFrom("/usr/lib/kframework/bin/kompile")).toEqual({
      path: "/usr/lib/kframework",
      binDir: "/usr/lib/kframework/bin",
      builtinDir: "/usr/lib/kframework/include/kframework/builtin",
    });
  });

  test("symlinks are not resolved — upstream's behaviour, kept deliberately", () => {
    // A `kompile` symlinked into `~/.local/bin` reports `~/.local` as the
    // prefix.  "Fixing" it would silently change which builtins a build sees.
    expect(kDistributionFrom("/home/u/.local/bin/kompile").builtinDir).toBe(
      "/home/u/.local/include/kframework/builtin",
    );
  });
});

describe("getKDistribution", () => {
  test("is memoised, including the negative answer", async () => {
    const first = await getKDistribution();
    expect(await getKDistribution()).toBe(first);
    // No assertion about *whether* K is installed: this suite must pass on a
    // machine with it and on one without.
    if (first !== undefined) expect(first.builtinDir).toEndWith("include/kframework/builtin");
  });

  test("clearing the cache lets the question be asked again", async () => {
    await getKDistribution();
    clearKDistributionCache();
    // Same value, freshly computed; the point is only that it does not throw.
    expect(await getKDistribution()).toEqual(await getKDistribution());
  });
});

//////////////////////////////
// Version parsing          //
//////////////////////////////

describe("parseKVersion", () => {
  test("a released version", () => {
    const version = parseKVersion("v7.1.337");
    expect(version).toEqual({ major: 7, minor: 1, patch: 337, git: undefined, text: "v7.1.337" });
  });

  test("a git-describe version", () => {
    const version = parseKVersion("v7.1.337-12-gabcdef1234");
    expect(version.major).toBe(7);
    expect(version.git).toEqual({ ahead: 12, rev: "abcdef1234", dirty: false });
    expect(version.text).toBe("v7.1.337-12-gabcdef1234");
  });

  test("a dirty git-describe version", () => {
    const version = parseKVersion("v7.1.337-12-gabcdef1234-dirty");
    expect(version.git).toEqual({ ahead: 12, rev: "abcdef1234", dirty: true });
    expect(version.text).toBe("v7.1.337-12-gabcdef1234-dirty");
  });

  test("'-dirty' without a commit count is not a version", () => {
    // `dirty` lives *inside* the `git` group upstream (`kbuild/utils.py:44-46`),
    // and `git describe --dirty` never emits the suffix on its own.
    expect(() => parseKVersion("v7.1.337-dirty")).toThrow(KVersionParseError);
  });

  const rejected = [
    "7.1.337", // no leading v
    "v7.1", // no patch
    "v7.1.337-12", // ahead without a rev
    "v7.1.337-12-gabcdef123", // nine hex digits, not ten
    "v7.1.337-12-gABCDEF1234", // uppercase rev
    "v7.1.337-12-gabcdef12345", // eleven hex digits
    "v07.1.337", // leading zero
    " v7.1.337", // not a full match
    "v7.1.337 ",
    "",
  ];
  for (const text of rejected) {
    test(`rejects ${JSON.stringify(text)}`, () => {
      const error = caught(() => parseKVersion(text), KVersionParseError);
      expect(error.message).toBe(`Invalid K version string: ${text}`);
      expect(error.text).toBe(text);
    });
  }

  test("accepts a major of 10 and up, which upstream's `[1-9]+` rejects", () => {
    // The one documented divergence in this pattern: `[1-9]+` has no `0`, so
    // `v10.0.0` fails to match upstream.  K has not reached major 10, so the
    // bug has never fired — and will, silently, on the day it does.
    expect(parseKVersion("v10.0.0").major).toBe(10);
    expect(parseKVersion("v7.0.0")).toEqual({ major: 7, minor: 0, patch: 0, git: undefined, text: "v7.0.0" });
  });

  test("round-trips through `text`", () => {
    for (const text of ["v7.1.337", "v7.1.337-1-g0123456789", "v7.1.337-99-gffffffffff-dirty"]) {
      expect(parseKVersion(parseKVersion(text).text).text).toBe(text);
    }
  });
});

describe("kVersion", () => {
  test("strips the 'K version:' label off the first line and parses the rest", async () => {
    // `k_version` slices the first line at column 14 (`kbuild/utils.py:76`),
    // which is `len('K version:') + 4` and works only because the padding is
    // exactly four spaces.  Stripping by pattern accepts that and survives a
    // change nobody would think to announce.
    const dir = await scratch();
    const bin = await fakeBin(dir, "kompile", "echo 'K version:    v7.1.337'; echo 'Build date: whenever'");
    expect((await kVersion([bin])).text).toBe("v7.1.337");
  });

  test("tolerates padding the column-14 slice would not", async () => {
    const dir = await scratch();
    const bin = await fakeBin(dir, "kompile", "echo 'K version: v7.1.337-3-g0123456789'");
    expect((await kVersion([bin])).git?.ahead).toBe(3);
  });

  test("a first line with no version throws KVersionParseError", async () => {
    const dir = await scratch();
    const bin = await fakeBin(dir, "kompile", "echo 'command not found'");
    await caughtAsync(kVersion([bin]), KVersionParseError);
  });
});
