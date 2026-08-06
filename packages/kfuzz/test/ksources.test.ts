/**
 * The house drift check, offline: `checkKfuzzSources` takes its fetcher as an
 * argument, so nothing here reaches the network.
 */

import { describe, expect, test } from "bun:test";

import { checkKfuzzSources, sha256Hex, type KfuzzSourceFetcher } from "../src/ksources.ts";
import { caughtAsync } from "./caught.ts";
import { K_COMMIT, K_RELEASE, TRANSCRIBED_FROM, type KfuzzTranscribedSource } from "../src/version.ts";

const encoder = new TextEncoder();
const SHA_ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const SHA_EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const offline: KfuzzSourceFetcher = () => Promise.reject(new Error("offline"));

function serving(bodies: Record<string, string>): KfuzzSourceFetcher {
  return (path) => Promise.resolve(bodies[path] === undefined ? undefined : encoder.encode(bodies[path]));
}

const sources: readonly KfuzzTranscribedSource[] = [
  { path: "pyk/a.py", sha256: SHA_ABC, lines: 1, tier: "transcription", why: "test source" },
  { path: "pyk/test_a.py", sha256: SHA_EMPTY, lines: 1, tier: "test-oracle", why: "test oracle" },
];

describe("sha256Hex", () => {
  test("hashes exactly its supplied view", async () => {
    const shared = encoder.encode("XXXabcXXX");
    expect(await sha256Hex(shared.subarray(3, 6))).toBe(SHA_ABC);
  });
});

describe("checkKfuzzSources", () => {
  test("reports unchanged only when every recorded source matches", async () => {
    const report = await checkKfuzzSources(
      "v9.9.9",
      serving({ "pyk/a.py": "abc", "pyk/test_a.py": "" }),
      sources,
      K_RELEASE,
    );
    expect(report.verdict).toBe("unchanged");
    expect(report.recordedAt).toBe(K_RELEASE);
    expect(report.files.map((file) => file.status)).toEqual(["unchanged", "unchanged"]);
  });

  test("a changed transcription is a changed verdict", async () => {
    const report = await checkKfuzzSources(
      "v9.9.9",
      serving({ "pyk/a.py": "different", "pyk/test_a.py": "" }),
      sources,
    );
    expect(report.verdict).toBe("changed");
    expect(report.files[0]?.actual).not.toBe(SHA_ABC);
  });

  test("a changed *test oracle* is also a changed verdict — both tiers gate", async () => {
    // kfuzz.py has no unit test at all, so test_fuzz.py is the specification.
    // A diff there is a real finding, not an advisory one.
    const report = await checkKfuzzSources(
      "v9.9.9",
      serving({ "pyk/a.py": "abc", "pyk/test_a.py": "rewritten" }),
      sources,
    );
    expect(report.verdict).toBe("changed");
    expect(report.files[1]?.tier).toBe("test-oracle");
  });

  test("changed outranks could-not-locate", async () => {
    const report = await checkKfuzzSources("v9.9.9", serving({ "pyk/a.py": "different" }), sources);
    expect(report.verdict).toBe("changed");
    expect(report.files.map((file) => file.status)).toEqual(["changed", "missing"]);
  });

  test("a missing path stays distinct from a changed one", async () => {
    const report = await checkKfuzzSources("v9.9.9", serving({ "pyk/a.py": "abc" }), sources);
    expect(report.verdict).toBe("could-not-locate");
    expect(report.files[1]?.actual).toBeUndefined();
  });

  test("a fetch failure propagates instead of manufacturing a K verdict", async () => {
    const thrown = await caughtAsync(checkKfuzzSources("v9.9.9", offline, sources), Error);
    expect(thrown.message).toBe("offline");
  });
});

describe("the manifest itself", () => {
  test("names the pinned release and commit", () => {
    expect(K_RELEASE).toBe("v7.1.337");
    expect(K_COMMIT).toHaveLength(40);
  });

  test("declares kfuzz.py and the only upstream test, and nothing else", () => {
    expect(TRANSCRIBED_FROM.map((source) => source.path)).toEqual([
      "pyk/src/pyk/ktool/kfuzz.py",
      "pyk/src/tests/integration/ktool/test_fuzz.py",
    ]);
  });

  test("every entry carries a lowercase-hex sha256, a line count and a reason", () => {
    for (const source of TRANSCRIBED_FROM) {
      expect(source.sha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(source.lines).toBeGreaterThan(0);
      expect(source.why.length).toBeGreaterThan(20);
    }
  });

  test("the sibling-pinned sources are deliberately absent", () => {
    // Duplicating a hash that `@kframework-ts/ktool` and `@kframework-ts/kore`
    // already carry would create two places to update. See version.ts's header.
    const paths = TRANSCRIBED_FROM.map((source) => source.path);
    expect(paths).not.toContain("pyk/src/pyk/ktool/krun.py");
    expect(paths).not.toContain("pyk/src/pyk/kore/prelude.py");
    expect(paths).not.toContain("pyk/src/pyk/kore/parser.py");
    expect(paths).not.toContain("pyk/src/pyk/kore/manip.py");
  });
});
