/**
 * The upstream-drift check, exercised offline.
 *
 * The fetcher is an argument, so nothing here reaches the network; the tests
 * serve fixed bodies and assert the three-valued verdict logic, then check the
 * manifest itself for the properties a manifest has to have (no duplicates,
 * real hashes, both tiers populated, and — the one that matters — that every
 * file this package's modules cite is actually declared).
 */

import { describe, expect, test } from "bun:test";

import { caughtAsync } from "./caught.ts";
import { checkKtoolSources, sha256Hex, type KtoolSourceFetcher } from "../src/ksources.ts";
import { K_COMMIT, K_RELEASE, TRANSCRIBED_FROM, type KtoolTranscribedSource } from "../src/version.ts";

const encoder = new TextEncoder();

const SHA_ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"; // "abc"
const SHA_EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"; // ""

const SOURCES: readonly KtoolTranscribedSource[] = [
  {
    repo: "runtimeverification/k",
    path: "pyk/ktool/kompile.py",
    sha256: SHA_ABC,
    lines: 668,
    tier: "format",
    why: "argv builders",
  },
  {
    repo: "runtimeverification/k",
    path: "kf/KompileOptions.java",
    sha256: SHA_EMPTY,
    lines: 254,
    tier: "content",
    why: "the flag inventory",
  },
];

/** A fetcher serving fixed bodies keyed by path, `undefined` otherwise. */
function serving(bodies: Record<string, string>): KtoolSourceFetcher {
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

describe("checkKtoolSources", () => {
  test("unchanged in both tiers when every file hashes to what was recorded", async () => {
    const report = await checkKtoolSources(
      "v9.9.9",
      serving({ "pyk/ktool/kompile.py": "abc", "kf/KompileOptions.java": "" }),
      SOURCES,
    );
    expect(report.verdicts).toEqual({ format: "unchanged", content: "unchanged" });
    expect(report.release).toBe("v9.9.9");
    expect(report.recordedAt).toBe(K_RELEASE);
  });

  test("a content-tier diff does not make the format tier changed", async () => {
    // The tiers are separate precisely so "K grew a flag" is not conflated with
    // "pyk's argv builder moved".
    const report = await checkKtoolSources(
      "v9.9.9",
      serving({ "pyk/ktool/kompile.py": "abc", "kf/KompileOptions.java": "new flag" }),
      SOURCES,
    );
    expect(report.verdicts).toEqual({ format: "unchanged", content: "changed" });
  });

  test("a missing path is could-not-locate, not changed", async () => {
    const report = await checkKtoolSources("v9.9.9", serving({ "kf/KompileOptions.java": "" }), SOURCES);
    expect(report.verdicts.format).toBe("could-not-locate");
    expect(report.files[0]?.status).toBe("missing");
    expect(report.files[0]?.actual).toBeUndefined();
  });

  test("changed outranks could-not-locate within a tier", async () => {
    const sources: readonly KtoolTranscribedSource[] = [
      ...SOURCES,
      { repo: "runtimeverification/k", path: "gone.py", sha256: SHA_ABC, lines: 1, tier: "format", why: "gone" },
    ];
    const report = await checkKtoolSources("v9.9.9", serving({ "pyk/ktool/kompile.py": "different" }), sources);
    expect(report.verdicts.format).toBe("changed");
  });

  test("a fetcher failure propagates — 'could not ask' is not a verdict", async () => {
    const error = await caughtAsync(
      checkKtoolSources("v9.9.9", () => Promise.reject(new Error("offline")), SOURCES),
      Error,
    );
    expect(error.message).toBe("offline");
  });

  test("`why` is carried through so a report can explain itself", async () => {
    const report = await checkKtoolSources("v9.9.9", serving({}), SOURCES);
    expect(report.files.map((f) => f.why)).toEqual(["argv builders", "the flag inventory"]);
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
      expect(source.lines).toBeGreaterThan(0);
      expect(source.why.length).toBeGreaterThan(10);
    }
  });

  test("names the sources milestones 1-5 transcribe in the format tier", () => {
    // `kprove.py` is format-tier, not the plan's content tier: parse-modules.ts
    // transcribes its argv builder, so a rename there makes our argv wrong.
    // The four K-distribution scripts are format-tier for the same reason and a
    // stronger one: they are the *only* specification `kserver.ts` and
    // `kparse.ts` have, pyk having no counterpart for either.
    expect(
      TRANSCRIBED_FROM.filter((s) => s.tier === "format")
        .map((s) => s.path)
        .toSorted(),
    ).toEqual([
      "k-distribution/src/main/scripts/bin/kparse",
      "k-distribution/src/main/scripts/bin/reset-kserver",
      "k-distribution/src/main/scripts/bin/spawn-kserver",
      "k-distribution/src/main/scripts/bin/stop-kserver",
      "k-distribution/src/main/scripts/lib/checkJava",
      "pyk/src/pyk/kbuild/utils.py",
      "pyk/src/pyk/kore/tools.py",
      "pyk/src/pyk/ktool/_ktool.py",
      "pyk/src/pyk/ktool/claim_index.py",
      "pyk/src/pyk/ktool/claim_loader.py",
      "pyk/src/pyk/ktool/kompile.py",
      "pyk/src/pyk/ktool/kprint.py",
      "pyk/src/pyk/ktool/kprove.py",
      "pyk/src/pyk/ktool/krun.py",
      "pyk/src/pyk/ktool/utils.py",
      "pyk/src/pyk/utils.py",
      "pyk/src/tests/unit/ktool/test_krun.py",
    ]);
  });

  test("the content tier declares what the K binaries accept, and where the goldens came from", () => {
    expect(
      TRANSCRIBED_FROM.filter((s) => s.tier === "content")
        .map((s) => s.path)
        .toSorted(),
    ).toEqual([
      "k-distribution/include/kframework/cparser/main.c",
      "k-distribution/src/main/scripts/bin/kore-print",
      "k-distribution/src/main/scripts/bin/krun",
      "k-frontend/src/main/java/org/kframework/kast/KastOptions.java",
      "k-frontend/src/main/java/org/kframework/kompile/KompileOptions.java",
      "pyk/src/tests/integration/kprove/test_get_claims.py",
      "pyk/src/tests/integration/test_kprint.py",
      "pyk/src/tests/integration/test_krun.py",
    ]);
  });

  test("pins the same K release and commit every sibling package pins", () => {
    expect(K_RELEASE).toBe("v7.1.337");
    expect(K_COMMIT).toBe("4a46d1231473b599c699160132fd6e76a5c46406");
    expect(K_COMMIT).toMatch(/^[0-9a-f]{40}$/);
  });
});
