/**
 * The upstream-drift check, exercised offline.
 *
 * The fetcher is injected, so none of this touches the network: the point under
 * test is the two-repo, two-tier verdict logic, not GitHub. The manifest's own
 * shape (hashes, repos, no duplicate paths, which files are format tier) is
 * asserted in `types.test.ts`, next to the constants it describes.
 */

import { describe, expect, test } from "bun:test";
import { checkKoreRpcSources, type KoreRpcReleases, type KoreRpcSourceFetcher, sha256Hex } from "../src/ksources.ts";
import { HASKELL_BACKEND_RELEASE, K_RELEASE, type KoreRpcTranscribedSource, TRANSCRIBED_FROM } from "../src/version.ts";

const encoder = new TextEncoder();

const SHA_ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"; // "abc"
const SHA_EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"; // ""

const RELEASES: KoreRpcReleases = { k: "v9.9.9", haskellBackend: "v0.9.9" };

/** A fetcher serving fixed bodies keyed by `repo:path`, `undefined` otherwise. */
function serving(bodies: Record<string, string>): KoreRpcSourceFetcher {
  return (repo, path) => {
    const body = bodies[`${repo}:${path}`];
    return Promise.resolve(body === undefined ? undefined : encoder.encode(body));
  };
}

const failing: KoreRpcSourceFetcher = () => Promise.reject(new Error("offline"));
const everythingEmpty: KoreRpcSourceFetcher = () => Promise.resolve(new Uint8Array());

const HB = "runtimeverification/haskell-backend";
const K = "runtimeverification/k";

const SOURCES: readonly KoreRpcTranscribedSource[] = [
  { repo: HB, path: "kore-rpc-types/src/Kore/JsonRpc/Types.hs", sha256: SHA_ABC, tier: "format" },
  { repo: HB, path: "kore-rpc-types/src/Kore/JsonRpc/Error.hs", sha256: SHA_EMPTY, tier: "format" },
  { repo: K, path: "pyk/src/pyk/kore/rpc.py", sha256: SHA_ABC, tier: "content" },
];

const ALL_UNCHANGED = serving({
  [`${HB}:kore-rpc-types/src/Kore/JsonRpc/Types.hs`]: "abc",
  [`${HB}:kore-rpc-types/src/Kore/JsonRpc/Error.hs`]: "",
  [`${K}:pyk/src/pyk/kore/rpc.py`]: "abc",
});

describe("sha256Hex", () => {
  test("matches the known digest of the empty input", async () => {
    expect(await sha256Hex(new Uint8Array())).toBe(SHA_EMPTY);
  });

  test("hashes only its own window of a shared buffer", async () => {
    const shared = encoder.encode("XXXabcXXX");
    expect(await sha256Hex(shared.subarray(3, 6))).toBe(SHA_ABC);
  });
});

describe("checkKoreRpcSources", () => {
  test("unchanged in both tiers when every file hashes to what was recorded", async () => {
    const report = await checkKoreRpcSources(RELEASES, ALL_UNCHANGED, SOURCES);
    expect(report.verdicts).toEqual({ format: "unchanged", content: "unchanged" });
    expect(report.files.map((f) => f.status)).toEqual(["unchanged", "unchanged", "unchanged"]);
    expect(report.releases).toEqual(RELEASES);
  });

  test("each repository is asked at its own release", async () => {
    const seen: string[] = [];
    const spy: KoreRpcSourceFetcher = (repo, _path, release) => {
      seen.push(`${repo}@${release}`);
      return Promise.resolve(new Uint8Array());
    };
    await checkKoreRpcSources(RELEASES, spy, SOURCES);
    expect(seen.toSorted()).toEqual([`${HB}@v0.9.9`, `${HB}@v0.9.9`, `${K}@v9.9.9`]);
  });

  test("a content-tier diff does not touch the format verdict", async () => {
    const report = await checkKoreRpcSources(
      RELEASES,
      serving({
        [`${HB}:kore-rpc-types/src/Kore/JsonRpc/Types.hs`]: "abc",
        [`${HB}:kore-rpc-types/src/Kore/JsonRpc/Error.hs`]: "",
        [`${K}:pyk/src/pyk/kore/rpc.py`]: "abc CHANGED",
      }),
      SOURCES,
    );
    expect(report.verdicts).toEqual({ format: "unchanged", content: "changed" });
  });

  test("a format-tier diff does not touch the content verdict", async () => {
    const report = await checkKoreRpcSources(
      RELEASES,
      serving({
        [`${HB}:kore-rpc-types/src/Kore/JsonRpc/Types.hs`]: "abc CHANGED",
        [`${HB}:kore-rpc-types/src/Kore/JsonRpc/Error.hs`]: "",
        [`${K}:pyk/src/pyk/kore/rpc.py`]: "abc",
      }),
      SOURCES,
    );
    expect(report.verdicts).toEqual({ format: "changed", content: "unchanged" });
    const changed = report.files.find((f) => f.status === "changed");
    expect(changed?.path).toBe("kore-rpc-types/src/Kore/JsonRpc/Types.hs");
    expect(changed?.actual).toBeDefined();
    expect(changed?.actual).not.toBe(changed?.expected);
  });

  test("a missing path is could-not-locate, and changed outranks it within a tier", async () => {
    const missingOnly = await checkKoreRpcSources(
      RELEASES,
      serving({
        [`${HB}:kore-rpc-types/src/Kore/JsonRpc/Error.hs`]: "",
        [`${K}:pyk/src/pyk/kore/rpc.py`]: "abc",
      }),
      SOURCES,
    );
    expect(missingOnly.verdicts.format).toBe("could-not-locate");
    expect(missingOnly.files[0]?.status).toBe("missing");
    expect(missingOnly.files[0]?.actual).toBeUndefined();

    const missingAndChanged = await checkKoreRpcSources(
      RELEASES,
      serving({
        [`${HB}:kore-rpc-types/src/Kore/JsonRpc/Error.hs`]: "CHANGED",
        [`${K}:pyk/src/pyk/kore/rpc.py`]: "abc",
      }),
      SOURCES,
    );
    expect(missingAndChanged.verdicts.format).toBe("changed");
  });

  test("a fetcher failure propagates instead of becoming a verdict", async () => {
    let message = "";
    try {
      await checkKoreRpcSources(RELEASES, failing, SOURCES);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("offline");
  });

  test("defaults: the real manifest and the recorded releases", async () => {
    // Every real declared file served empty: everything is `changed`, which
    // proves the default manifest is what gets consulted, without a network.
    const report = await checkKoreRpcSources(RELEASES, everythingEmpty);
    expect(report.files.length).toBe(TRANSCRIBED_FROM.length);
    expect(report.recordedAt).toEqual({ k: K_RELEASE, haskellBackend: HASKELL_BACKEND_RELEASE });
    expect(report.verdicts).toEqual({ format: "changed", content: "changed" });
  });
});
