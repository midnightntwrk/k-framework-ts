import { describe, expect, test } from "bun:test";
import { checkProofSources, sha256Hex, type ProofSourceFetcher } from "../src/ksources.ts";
import { TRANSCRIBED_FROM, type ProofTranscribedSource } from "../src/version.ts";

const encoder = new TextEncoder();
const SHA_ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const SHA_EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const offline: ProofSourceFetcher = () => Promise.reject(new Error("offline"));

function serving(bodies: Record<string, string>): ProofSourceFetcher {
  return (path) => Promise.resolve(bodies[path] === undefined ? undefined : encoder.encode(bodies[path]));
}

const sources: readonly ProofTranscribedSource[] = [
  { path: "pyk/a.py", sha256: SHA_ABC, lines: 1, tier: "transcription", why: "test source" },
  { path: "pyk/test_a.py", sha256: SHA_EMPTY, lines: 1, tier: "test-oracle", why: "test oracle" },
];

describe("sha256Hex", () => {
  test("hashes exactly its supplied view", async () => {
    const shared = encoder.encode("XXXabcXXX");
    expect(await sha256Hex(shared.subarray(3, 6))).toBe(SHA_ABC);
  });
});

describe("checkProofSources", () => {
  test("reports unchanged only when every recorded source matches", async () => {
    const report = await checkProofSources(
      "v9.9.9",
      serving({ "pyk/a.py": "abc", "pyk/test_a.py": "" }),
      sources,
      "v7.1.337",
    );
    expect(report.verdict).toBe("unchanged");
    expect(report.files.map((file) => file.status)).toEqual(["unchanged", "unchanged"]);
  });

  test("reports changed, including when another source is missing", async () => {
    const report = await checkProofSources("v9.9.9", serving({ "pyk/a.py": "different" }), sources);
    expect(report.verdict).toBe("changed");
    expect(report.files.map((file) => file.status)).toEqual(["changed", "missing"]);
  });

  test("keeps a missing path distinct from changed", async () => {
    const report = await checkProofSources("v9.9.9", serving({ "pyk/a.py": "abc" }), sources);
    expect(report.verdict).toBe("could-not-locate");
    expect(report.files[1]?.actual).toBeUndefined();
  });

  test("propagates fetch failures instead of manufacturing a K verdict", async () => {
    let thrown: unknown;
    try {
      await checkProofSources("v9.9.9", offline, sources);
    } catch (error) {
      thrown = error;
    }
    if (!(thrown instanceof Error)) throw new Error(`expected Error, got ${String(thrown)}`);
    expect(thrown.message).toBe("offline");
  });

  test("records each current proof implementation and test oracle source once", () => {
    expect(new Set(TRANSCRIBED_FROM.map((source) => source.path)).size).toBe(TRANSCRIBED_FROM.length);
    expect(TRANSCRIBED_FROM.every((source) => /^[0-9a-f]{64}$/u.test(source.sha256))).toBe(true);
    expect(TRANSCRIBED_FROM.some((source) => source.path.endsWith("reachability.py"))).toBe(true);
    expect(TRANSCRIBED_FROM.some((source) => source.tier === "test-oracle")).toBe(true);
  });
});
