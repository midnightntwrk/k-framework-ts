/**
 * The upstream-drift check, exercised offline, plus one thing the siblings
 * cannot do: verify a content-tier hash against a file that is **in the fixture
 * set**.
 *
 * `kompile` copies `k-frontend/src/main/resources/.../README.md` into every
 * kompiled directory verbatim, so each `README.md` under `fixtures/generated` is the
 * upstream file.  That makes the layout manifest's recorded hash checkable with
 * no network at all — the only entry in any `TRANSCRIBED_FROM` in this monorepo
 * for which that is true.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { checkKompiledSources, sha256Hex, type KompiledSourceFetcher } from "../src/ksources.ts";
import { caughtAsync } from "./caught.ts";
import { K_RELEASE, OBSERVED_LAYOUT, TRANSCRIBED_FROM, type KompiledTranscribedSource } from "../src/version.ts";
import { IMP_HASKELL, IMP_LLVM } from "./fixtures.ts";

const encoder = new TextEncoder();

const SHA_ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"; // "abc"
const SHA_EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"; // ""

const SOURCES: readonly KompiledTranscribedSource[] = [
  { repo: "runtimeverification/k", path: "pyk/ktool/kompile.py", sha256: SHA_ABC, tier: "format", why: "markers" },
  { repo: "runtimeverification/k", path: "kf/Kompile.java", sha256: SHA_EMPTY, tier: "content", why: "allRules.txt" },
];

/** A fetcher serving fixed bodies keyed by path, `undefined` otherwise. */
function serving(bodies: Record<string, string>): KompiledSourceFetcher {
  return (_repo, path) => {
    const body = bodies[path];
    return Promise.resolve(body === undefined ? undefined : encoder.encode(body));
  };
}

describe("sha256Hex", () => {
  test("matches the known digest of the empty input", async () => {
    expect(await sha256Hex(new Uint8Array())).toBe(SHA_EMPTY);
  });

  test("hashes only its own window of a shared buffer", async () => {
    expect(await sha256Hex(encoder.encode("XXXabcXXX").subarray(3, 6))).toBe(SHA_ABC);
  });
});

describe("checkKompiledSources", () => {
  test("unchanged in both tiers when every file hashes to what was recorded", async () => {
    const report = await checkKompiledSources(
      "v9.9.9",
      serving({ "pyk/ktool/kompile.py": "abc", "kf/Kompile.java": "" }),
      SOURCES,
    );
    expect(report.verdicts).toEqual({ format: "unchanged", content: "unchanged" });
    expect(report.release).toBe("v9.9.9");
    expect(report.recordedAt).toBe(K_RELEASE);
    expect(report.files.map((f) => f.status)).toEqual(["unchanged", "unchanged"]);
  });

  test("a content-tier diff does not make the format tier changed", async () => {
    // The tiers are separate precisely so that "kompile writes a new file" is
    // not conflated with "pyk's DefinitionInfo moved".
    const report = await checkKompiledSources(
      "v9.9.9",
      serving({ "pyk/ktool/kompile.py": "abc", "kf/Kompile.java": "moved" }),
      SOURCES,
    );
    expect(report.verdicts).toEqual({ format: "unchanged", content: "changed" });
  });

  test("a missing path is could-not-locate, not changed", async () => {
    const report = await checkKompiledSources("v9.9.9", serving({ "kf/Kompile.java": "" }), SOURCES);
    expect(report.verdicts.format).toBe("could-not-locate");
    expect(report.files[0]?.status).toBe("missing");
    expect(report.files[0]?.actual).toBeUndefined();
  });

  test("changed outranks could-not-locate within a tier", async () => {
    const sources: readonly KompiledTranscribedSource[] = [
      ...SOURCES,
      { repo: "runtimeverification/k", path: "gone.py", sha256: SHA_ABC, tier: "format", why: "gone" },
    ];
    const report = await checkKompiledSources("v9.9.9", serving({ "pyk/ktool/kompile.py": "different" }), sources);
    expect(report.verdicts.format).toBe("changed");
  });

  test("a fetcher failure propagates — 'could not ask' is not a verdict", async () => {
    const error = await caughtAsync(
      checkKompiledSources("v9.9.9", () => Promise.reject(new Error("offline")), SOURCES),
      Error,
    );
    expect(error.message).toBe("offline");
  });

  test("`why` is carried through so a report can explain itself", async () => {
    const report = await checkKompiledSources("v9.9.9", serving({}), SOURCES);
    expect(report.files.map((f) => f.why)).toEqual(["markers", "allRules.txt"]);
  });
});

describe("the manifest", () => {
  test("declares both tiers, with no duplicate paths", () => {
    const paths = TRANSCRIBED_FROM.map((s) => s.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(TRANSCRIBED_FROM.some((s) => s.tier === "format")).toBe(true);
    expect(TRANSCRIBED_FROM.some((s) => s.tier === "content")).toBe(true);
    for (const source of TRANSCRIBED_FROM) {
      expect(source.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(source.why.length).toBeGreaterThan(10);
    }
  });

  test("names the four pyk sources this package transcribes in the format tier", () => {
    expect(
      TRANSCRIBED_FROM.filter((s) => s.tier === "format")
        .map((s) => s.path)
        .toSorted(),
    ).toEqual([
      "pyk/src/pyk/kast/formatter.py",
      "pyk/src/pyk/kore/kompiled.py",
      "pyk/src/pyk/ktool/kompile.py",
      "pyk/src/pyk/ktool/kprint.py",
    ]);
  });

  test("the kompiled README's recorded hash is verifiable offline, against the fixtures", async () => {
    // The one manifest entry whose upstream bytes are also fixture bytes:
    // `KompileFrontEnd.java:101-107` copies the resource unmodified, so the
    // file in every kompiled directory is the file in the k repo.
    const recorded = TRANSCRIBED_FROM.find((s) => s.path.endsWith("utils/file/README.md"));
    expect(recorded).toBeDefined();

    const haskell = readFileSync(join(IMP_HASKELL, "README.md"));
    const llvm = readFileSync(join(IMP_LLVM, "README.md"));
    expect(haskell.equals(llvm)).toBe(true);
    expect(await sha256Hex(new Uint8Array(haskell))).toBe(recorded!.sha256);
  });

  test("that README carries the disclaimer this package's framing rests on", () => {
    const readme = readFileSync(join(IMP_HASKELL, "README.md"), "utf8");
    expect(readme).toContain("subject to change without warning");
    expect(readme).toContain("give unsound\nresults");
    expect(readme).toContain("encouraged to use the PYK library");
  });
});

describe("OBSERVED_LAYOUT", () => {
  test("every artifact this package reads is present in the fixture directory", () => {
    // The layout is recorded in code so drift is visible.
    // The `read` entries are the contract; `parsed.json` and the
    // debug dumps were deliberately not vendored, so they are not checked.
    const readable = OBSERVED_LAYOUT.filter((a) => a.status === "read").map((a) => a.file);
    for (const file of readable) expect(() => readFileSync(join(IMP_HASKELL, file))).not.toThrow();
  });

  test("nothing refused was vendored — the fixture cannot tempt a reader", () => {
    for (const artifact of OBSERVED_LAYOUT.filter((a) => a.status === "refused")) {
      expect(() => readFileSync(join(IMP_HASKELL, artifact.file))).toThrow();
    }
  });

  test("no file is listed twice", () => {
    const files = OBSERVED_LAYOUT.map((a) => a.file);
    expect(new Set(files).size).toBe(files.length);
  });
});
