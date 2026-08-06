/**
 * The upstream-drift check, exercised offline.
 *
 * The fetcher is injected, so none of this touches the network: the point
 * under test is the two-tier verdict logic and the per-repo release routing,
 * not GitHub.
 */

import { describe, expect, test } from "bun:test";
import { checkKoreSources, type KoreSourceFetcher, sha256Hex } from "../src/ksources.ts";
import { HASKELL_BACKEND_RELEASE, K_RELEASE, type KoreTranscribedSource, TRANSCRIBED_FROM } from "../src/version.ts";

const encoder = new TextEncoder();

const SHA_ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"; // "abc"
const SHA_EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"; // ""

/** A fetcher serving fixed bodies keyed `repo:path`, `undefined` otherwise. */
function serving(bodies: Record<string, string>): KoreSourceFetcher {
  return (repo, path) => {
    const body = bodies[`${repo}:${path}`];
    return Promise.resolve(body === undefined ? undefined : encoder.encode(body));
  };
}

/** A fetcher that cannot reach the network at all. */
const failing: KoreSourceFetcher = () => Promise.reject(new Error("offline"));

/** Serves every path as an empty body, so every real hash comes out `changed`. */
const everythingEmpty: KoreSourceFetcher = () => Promise.resolve(new Uint8Array());

const RELEASES = { k: "v9.9.9", haskellBackend: "v9.9.8" };

const SOURCES: readonly KoreTranscribedSource[] = [
  { repo: "runtimeverification/k", path: "pyk/syntax.py", sha256: SHA_ABC, tier: "format" },
  { repo: "runtimeverification/haskell-backend", path: "docs/kore-syntax.md", sha256: SHA_EMPTY, tier: "format" },
  { repo: "runtimeverification/k", path: "kf/ModuleToKORE.java", sha256: SHA_ABC, tier: "content" },
];

describe("sha256Hex", () => {
  test("matches the known digest of the empty input", async () => {
    expect(await sha256Hex(new Uint8Array())).toBe(SHA_EMPTY);
  });

  test("hashes only its own window of a shared buffer", async () => {
    const shared = encoder.encode("XXXabcXXX");
    expect(await sha256Hex(shared.subarray(3, 6))).toBe(SHA_ABC);
  });
});

describe("checkKoreSources", () => {
  const allUnchanged = serving({
    "runtimeverification/k:pyk/syntax.py": "abc",
    "runtimeverification/haskell-backend:docs/kore-syntax.md": "",
    "runtimeverification/k:kf/ModuleToKORE.java": "abc",
  });

  test("unchanged in both tiers when every file hashes to what was recorded", async () => {
    const report = await checkKoreSources(RELEASES, allUnchanged, SOURCES);
    expect(report.verdicts).toEqual({ format: "unchanged", content: "unchanged" });
    expect(report.files.map((f) => f.status)).toEqual(["unchanged", "unchanged", "unchanged"]);
    expect(report.releases).toEqual(RELEASES);
  });

  test("routes the per-repo release to the fetcher", async () => {
    const seen: string[] = [];
    const spy: KoreSourceFetcher = (repo, path, release) => {
      seen.push(`${repo}@${release}`);
      return allUnchanged(repo, path, release);
    };
    await checkKoreSources(RELEASES, spy, SOURCES);
    expect(seen.toSorted()).toEqual([
      "runtimeverification/haskell-backend@v9.9.8",
      "runtimeverification/k@v9.9.9",
      "runtimeverification/k@v9.9.9",
    ]);
  });

  test("a content-tier diff does not touch the format verdict", async () => {
    const report = await checkKoreSources(
      RELEASES,
      serving({
        "runtimeverification/k:pyk/syntax.py": "abc",
        "runtimeverification/haskell-backend:docs/kore-syntax.md": "",
        "runtimeverification/k:kf/ModuleToKORE.java": "abc CHANGED",
      }),
      SOURCES,
    );
    expect(report.verdicts).toEqual({ format: "unchanged", content: "changed" });
  });

  test("a format-tier diff does not touch the content verdict", async () => {
    const report = await checkKoreSources(
      RELEASES,
      serving({
        "runtimeverification/k:pyk/syntax.py": "abc CHANGED",
        "runtimeverification/haskell-backend:docs/kore-syntax.md": "",
        "runtimeverification/k:kf/ModuleToKORE.java": "abc",
      }),
      SOURCES,
    );
    expect(report.verdicts).toEqual({ format: "changed", content: "unchanged" });
    const changed = report.files.find((f) => f.status === "changed");
    expect(changed?.path).toBe("pyk/syntax.py");
    expect(changed?.actual).toBeDefined();
    expect(changed?.actual).not.toBe(changed?.expected);
  });

  test("a missing path is could-not-locate, and changed outranks it within a tier", async () => {
    const missingOnly = await checkKoreSources(
      RELEASES,
      serving({
        // syntax.py absent entirely
        "runtimeverification/haskell-backend:docs/kore-syntax.md": "",
        "runtimeverification/k:kf/ModuleToKORE.java": "abc",
      }),
      SOURCES,
    );
    expect(missingOnly.verdicts.format).toBe("could-not-locate");
    expect(missingOnly.files[0]?.status).toBe("missing");
    expect(missingOnly.files[0]?.actual).toBeUndefined();

    const missingAndChanged = await checkKoreSources(
      RELEASES,
      serving({
        "runtimeverification/haskell-backend:docs/kore-syntax.md": "CHANGED",
        "runtimeverification/k:kf/ModuleToKORE.java": "abc",
      }),
      SOURCES,
    );
    expect(missingAndChanged.verdicts.format).toBe("changed");
  });

  test("a fetcher failure propagates instead of becoming a verdict", async () => {
    let message = "";
    try {
      await checkKoreSources(RELEASES, failing, SOURCES);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("offline");
  });

  test("defaults: the real manifest and the recorded releases", async () => {
    // Every real declared file served empty: everything is `changed`, which
    // proves the default manifest is what gets consulted, without a network.
    const report = await checkKoreSources(RELEASES, everythingEmpty);
    expect(report.files.length).toBe(TRANSCRIBED_FROM.length);
    expect(report.recordedAt).toEqual({ k: K_RELEASE, haskellBackend: HASKELL_BACKEND_RELEASE });
    expect(report.verdicts).toEqual({ format: "changed", content: "changed" });
  });
});

describe("the recorded manifest", () => {
  test("declares both tiers, valid hashes, and no duplicate paths", () => {
    expect(TRANSCRIBED_FROM.some((s) => s.tier === "format")).toBe(true);
    expect(TRANSCRIBED_FROM.some((s) => s.tier === "content")).toBe(true);
    for (const s of TRANSCRIBED_FROM) expect(s.sha256).toMatch(/^[0-9a-f]{64}$/);
    const keys = TRANSCRIBED_FROM.map((s) => `${s.repo}:${s.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
