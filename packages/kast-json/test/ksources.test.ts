/**
 * The K-compatibility check, exercised offline.
 *
 * The fetcher is injected, so none of this touches the network: the point under
 * test is the verdict logic and the three-valued reporting, not GitHub.
 */

import { describe, expect, test } from "bun:test";
import { exitCodeFor, main, render } from "../src/cli.ts";
import { checkKRevisions, checkKSources, type KSourceFetcher, sha256Hex } from "../src/ksources.ts";
import { SORT_SPELLING_SOURCE, TRANSCRIBED_FROM, type KastRevision } from "../src/version.ts";

const encoder = new TextEncoder();

/** A fetcher serving fixed bodies, and `undefined` for anything unlisted. */
function serving(bodies: Record<string, string>): KSourceFetcher {
  return (path) => {
    const body = bodies[path];
    return Promise.resolve(body === undefined ? undefined : encoder.encode(body));
  };
}

/** A fetcher that cannot reach the network at all. */
const failing: KSourceFetcher = () => Promise.reject(new Error("offline"));

// Known digests for the synthetic manifests below.
const SHA_ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"; // "abc"
const SHA_EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"; // ""
const SHA_XYZ = "3608bca1e44ea6c4d268eb6db02260269892c0b42b86bbf1e77a6fa16c3c9282"; // "xyz"

describe("sha256Hex", () => {
  test("matches the known digest of the empty input", async () => {
    expect(await sha256Hex(new Uint8Array())).toBe(SHA_EMPTY);
  });

  test("matches the known digest of 'abc'", async () => {
    expect(await sha256Hex(encoder.encode("abc"))).toBe(SHA_ABC);
  });

  test("hashes only its own window of a shared buffer", async () => {
    const shared = encoder.encode("XXXabcXXX");
    const window = shared.subarray(3, 6);
    expect(await sha256Hex(window)).toBe(await sha256Hex(encoder.encode("abc")));
  });
});

describe("checkKSources (single-baseline core)", () => {
  const sources = [
    { path: "a/ToJson.java", sha256: SHA_ABC },
    { path: "a/JsonParser.java", sha256: SHA_EMPTY },
  ] as const;

  test("unchanged when every declared file hashes to what was recorded", async () => {
    const report = await checkKSources(
      "v9.9.9",
      serving({ "a/ToJson.java": "abc", "a/JsonParser.java": "" }),
      sources,
      "v7.1.191",
    );
    expect(report.verdict).toBe("unchanged");
    expect(report.files.map((f) => f.status)).toEqual(["unchanged", "unchanged"]);
    expect(report.release).toBe("v9.9.9");
    expect(report.recordedAt).toBe("v7.1.191");
  });

  test("changed when a declared file differs, and reports the observed hash", async () => {
    const report = await checkKSources(
      "v9.9.9",
      serving({ "a/ToJson.java": "abc!", "a/JsonParser.java": "" }),
      sources,
      "v7.1.191",
    );
    expect(report.verdict).toBe("changed");
    expect(report.files[0]?.status).toBe("changed");
    expect(report.files[0]?.actual).toBeDefined();
    expect(report.files[0]?.actual).not.toBe(report.files[0]?.expected);
  });

  test("could-not-locate when a path is gone — not 'changed'", async () => {
    const report = await checkKSources("v9.9.9", serving({ "a/JsonParser.java": "" }), sources, "v7.1.191");
    expect(report.verdict).toBe("could-not-locate");
    expect(report.files[0]?.status).toBe("missing");
    // A missing file has no observed hash to report.
    expect(report.files[0]?.actual).toBeUndefined();
  });

  test("a definite difference outranks an inconclusive missing path", async () => {
    const report = await checkKSources("v9.9.9", serving({ "a/ToJson.java": "different" }), sources, "v7.1.191");
    expect(report.files.map((f) => f.status)).toEqual(["changed", "missing"]);
    expect(report.verdict).toBe("changed");
  });

  test("a fetch failure propagates rather than becoming a verdict", async () => {
    let thrown: unknown;
    try {
      await checkKSources("v9.9.9", failing, sources, "v7.1.191");
    } catch (error) {
      thrown = error;
    }
    if (!(thrown instanceof Error)) throw new Error(`expected an Error, got ${String(thrown)}`);
    expect(thrown.message).toBe("offline");
  });
});

describe("checkKRevisions (which transcription does this K speak?)", () => {
  // A miniature of the real manifest: two revisions sharing the writer path,
  // differing in the reader, plus a shared sort-spelling source.
  const rev = (kastVersion: 3 | 4, jsonParserSha: string): KastRevision => ({
    kastVersion,
    firstRelease: "vF",
    recordedAt: "vR",
    note: "test",
    toJson: { path: "a/ToJson.java", sha256: SHA_ABC, lines: 1 },
    jsonParser: { path: "a/JsonParser.java", sha256: jsonParserSha, lines: 1 },
  });
  const revisions = [rev(3, SHA_EMPTY), rev(4, SHA_XYZ)] as const;
  const spelling = { path: "a/ADT.scala", sha256: SHA_ABC };

  test("matches the revision whose every file (and the sort spelling) is byte-identical", async () => {
    const report = await checkKRevisions(
      "v9.9.9",
      serving({ "a/ToJson.java": "abc", "a/JsonParser.java": "xyz", "a/ADT.scala": "abc" }),
      revisions,
      spelling,
    );
    expect(report.verdict).toBe("matched");
    expect(report.matched?.kastVersion).toBe(4);
    expect(report.revisions.map((r) => r.matches)).toEqual([false, true]);
  });

  test("a changed sort spelling defeats every revision — flattenSort would be wrong", async () => {
    const report = await checkKRevisions(
      "v9.9.9",
      serving({ "a/ToJson.java": "abc", "a/JsonParser.java": "xyz", "a/ADT.scala": "MOVED" }),
      revisions,
      spelling,
    );
    expect(report.verdict).toBe("changed");
    expect(report.matched).toBeUndefined();
  });

  test("changed when every path exists but no revision matches", async () => {
    const report = await checkKRevisions(
      "v9.9.9",
      serving({ "a/ToJson.java": "abc", "a/JsonParser.java": "neither", "a/ADT.scala": "abc" }),
      revisions,
      spelling,
    );
    expect(report.verdict).toBe("changed");
  });

  test("could-not-locate when a path is gone and nothing present has definitely drifted", async () => {
    const report = await checkKRevisions(
      "v9.9.9",
      serving({ "a/ToJson.java": "abc", "a/ADT.scala": "abc" }),
      revisions,
      spelling,
    );
    expect(report.verdict).toBe("could-not-locate");
    expect(report.files.find((f) => f.path === "a/JsonParser.java")?.actual).toBeUndefined();
  });

  test("a definite drift outranks a missing path, as in the single-baseline core", async () => {
    const report = await checkKRevisions(
      "v9.9.9",
      serving({ "a/ToJson.java": "DRIFTED", "a/ADT.scala": "abc" }),
      revisions,
      spelling,
    );
    expect(report.verdict).toBe("changed");
  });

  test("each distinct path is fetched exactly once", async () => {
    const seen: string[] = [];
    const counting: KSourceFetcher = (path) => {
      seen.push(path);
      return Promise.resolve(encoder.encode(""));
    };
    await checkKRevisions("v9.9.9", counting, revisions, spelling);
    expect(seen.toSorted()).toEqual(["a/ADT.scala", "a/JsonParser.java", "a/ToJson.java"]);
  });

  test("the real manifest's revisions differ pairwise, so at most one can match", () => {
    const pairs = TRANSCRIBED_FROM.map((r) => `${r.toJson.sha256}:${r.jsonParser.sha256}`);
    expect(new Set(pairs).size).toBe(TRANSCRIBED_FROM.length);
    expect(SORT_SPELLING_SOURCE.path.endsWith("ADT.scala")).toBe(true);
  });
});

describe("exit codes are contractual", () => {
  test("0 matched, 1 changed, 3 could not locate", () => {
    expect(exitCodeFor("matched")).toBe(0);
    expect(exitCodeFor("changed")).toBe(1);
    expect(exitCodeFor("could-not-locate")).toBe(3);
  });
});

describe("render", () => {
  test("a missing path is not described as a compatibility verdict", () => {
    const text = render({
      release: "v9.9.9",
      verdict: "could-not-locate",
      revisions: TRANSCRIBED_FROM.map((revision) => ({ revision, matches: false })),
      files: [{ path: "a/ToJson.java" }],
    });
    expect(text).toContain("GONE");
    expect(text).toContain("not a verdict about compatibility");
  });

  test("a match names the KAST version the release speaks", () => {
    const matched = TRANSCRIBED_FROM[2];
    const text = render({
      release: "v7.1.337",
      verdict: "matched",
      matched,
      revisions: TRANSCRIBED_FROM.map((revision) => ({ revision, matches: revision === matched })),
      files: [],
    });
    expect(text).toContain("emits KAST v4");
    expect(text).toContain("MATCH");
  });
});

describe("cli", () => {
  /** Runs `main` with captured sinks. */
  async function run(argv: readonly string[], fetcher?: KSourceFetcher) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(
      argv,
      (t) => {
        out.push(t);
      },
      (t) => {
        err.push(t);
      },
      fetcher ?? serving({}),
    );
    return { code, out: out.join(""), err: err.join("") };
  }

  test("no arguments is a usage error, not a pass", async () => {
    const { code, out, err } = await run([]);
    expect(code).toBe(2);
    expect(err).toContain("check-k");
    expect(out).toBe("");
  });

  test("--help succeeds and goes to stdout", async () => {
    const { code, out } = await run(["--help"]);
    expect(code).toBe(0);
    expect(out).toContain("check-k <k-release>");
  });

  test("an unknown command exits 2", async () => {
    expect((await run(["frobnicate"])).code).toBe(2);
  });

  test("check-k requires exactly one release", async () => {
    expect((await run(["check-k"])).code).toBe(2);
    expect((await run(["check-k", "v1", "v2"])).code).toBe(2);
  });

  test("a fetch failure exits 2 — could not ask is not could not pass", async () => {
    const { code, err } = await run(["check-k", "v9.9.9"], failing);
    expect(code).toBe(2);
    expect(err).toContain("could not check v9.9.9");
    expect(err).toContain("offline");
  });

  test("a K release with the paths gone exits 3", async () => {
    const { code, out } = await run(["check-k", "v9.9.9"]);
    expect(code).toBe(3);
    expect(out).toContain("GONE");
  });
});
