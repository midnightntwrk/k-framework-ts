/**
 * The upstream-drift check, exercised offline.
 *
 * The fetcher is injected, so none of this touches the network: the point under
 * test is the two-tier verdict logic, not GitHub.
 */

import { describe, expect, test } from "bun:test";

import { checkKonvertSources, type KonvertSourceFetcher, sha256Hex } from "../src/ksources.ts";
import { K_RELEASE, type KonvertTranscribedSource, TRANSCRIBED_FROM } from "../src/version.ts";

const encoder = new TextEncoder();

const SHA_ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"; // "abc"
const SHA_EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"; // ""

/** A fetcher serving fixed bodies keyed by path, `undefined` otherwise. */
function serving(bodies: Record<string, string>): KonvertSourceFetcher {
  return (path) => {
    const body = bodies[path];
    return Promise.resolve(body === undefined ? undefined : encoder.encode(body));
  };
}

const failing: KonvertSourceFetcher = () => Promise.reject(new Error("offline"));
const everythingEmpty: KonvertSourceFetcher = () => Promise.resolve(new Uint8Array());

const SOURCES: readonly KonvertTranscribedSource[] = [
  { path: "pyk/konvert/_kast_to_kore.py", sha256: SHA_ABC, tier: "format", lines: 450 },
  { path: "pyk/konvert/_kore_to_kast.py", sha256: SHA_EMPTY, tier: "format", lines: 166 },
  { path: "kf/KoreToK.scala", sha256: SHA_ABC, tier: "content", lines: 180 },
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

describe("checkKonvertSources", () => {
  const allUnchanged = serving({
    "pyk/konvert/_kast_to_kore.py": "abc",
    "pyk/konvert/_kore_to_kast.py": "",
    "kf/KoreToK.scala": "abc",
  });

  test("unchanged in both tiers when every file hashes to what was recorded", async () => {
    const report = await checkKonvertSources("v9.9.9", allUnchanged, SOURCES);
    expect(report.verdicts).toEqual({ format: "unchanged", content: "unchanged" });
    expect(report.files.map((f) => f.status)).toEqual(["unchanged", "unchanged", "unchanged"]);
    expect(report.release).toBe("v9.9.9");
  });

  test("a content-tier diff does not touch the format verdict", async () => {
    const report = await checkKonvertSources(
      "v9.9.9",
      serving({
        "pyk/konvert/_kast_to_kore.py": "abc",
        "pyk/konvert/_kore_to_kast.py": "",
        "kf/KoreToK.scala": "abc CHANGED",
      }),
      SOURCES,
    );
    expect(report.verdicts).toEqual({ format: "unchanged", content: "changed" });
  });

  test("a format-tier diff does not touch the content verdict", async () => {
    const report = await checkKonvertSources(
      "v9.9.9",
      serving({
        "pyk/konvert/_kast_to_kore.py": "abc CHANGED",
        "pyk/konvert/_kore_to_kast.py": "",
        "kf/KoreToK.scala": "abc",
      }),
      SOURCES,
    );
    expect(report.verdicts).toEqual({ format: "changed", content: "unchanged" });
    const changed = report.files.find((f) => f.status === "changed");
    expect(changed?.path).toBe("pyk/konvert/_kast_to_kore.py");
    expect(changed?.actual).toBeDefined();
    expect(changed?.actual).not.toBe(changed?.expected);
  });

  test("a missing path is could-not-locate, and changed outranks it within a tier", async () => {
    const missingOnly = await checkKonvertSources(
      "v9.9.9",
      serving({ "pyk/konvert/_kore_to_kast.py": "", "kf/KoreToK.scala": "abc" }),
      SOURCES,
    );
    expect(missingOnly.verdicts.format).toBe("could-not-locate");
    expect(missingOnly.files[0]?.status).toBe("missing");
    expect(missingOnly.files[0]?.actual).toBeUndefined();

    const missingAndChanged = await checkKonvertSources(
      "v9.9.9",
      serving({ "pyk/konvert/_kore_to_kast.py": "CHANGED", "kf/KoreToK.scala": "abc" }),
      SOURCES,
    );
    expect(missingAndChanged.verdicts.format).toBe("changed");
  });

  test("a fetcher failure propagates instead of becoming a verdict", async () => {
    let message = "";
    try {
      await checkKonvertSources("v9.9.9", failing, SOURCES);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("offline");
  });

  test("defaults: the real manifest and the recorded release", async () => {
    // Every real declared file served empty: everything is `changed`, which
    // proves the default manifest is what gets consulted, without a network.
    const report = await checkKonvertSources("v9.9.9", everythingEmpty);
    expect(report.files.length).toBe(TRANSCRIBED_FROM.length);
    expect(report.recordedAt).toBe(K_RELEASE);
    expect(report.verdicts).toEqual({ format: "changed", content: "changed" });
  });
});

describe("the recorded manifest", () => {
  test("declares both tiers, valid hashes, and no duplicate paths", () => {
    expect(TRANSCRIBED_FROM.some((s) => s.tier === "format")).toBe(true);
    expect(TRANSCRIBED_FROM.some((s) => s.tier === "content")).toBe(true);
    for (const s of TRANSCRIBED_FROM) expect(s.sha256).toMatch(/^[0-9a-f]{64}$/);
    const paths = TRANSCRIBED_FROM.map((s) => s.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  test("declares all four pyk konvert sources as format tier", () => {
    const format = TRANSCRIBED_FROM.filter((s) => s.tier === "format").map((s) => s.path);
    expect(format).toEqual([
      "pyk/src/pyk/konvert/_kast_to_kore.py",
      "pyk/src/pyk/konvert/_kore_to_kast.py",
      "pyk/src/pyk/konvert/_module_to_kore.py",
      "pyk/src/pyk/konvert/_utils.py",
    ]);
  });
});
