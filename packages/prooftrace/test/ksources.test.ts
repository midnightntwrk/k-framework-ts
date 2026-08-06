/**
 * The upstream-drift check, exercised offline, plus the manifest's own shape.
 *
 * The fetcher is injected, so none of this touches the network: what is under
 * test is the two-repo, three-tier verdict logic and the declared file list.
 */

import { describe, expect, test } from "bun:test";

import {
  checkProofTraceSources,
  sha256Hex,
  type ProofTraceReleases,
  type ProofTraceSourceFetcher,
} from "../src/ksources.ts";
import {
  K_COMMIT,
  K_RELEASE,
  LLVM_BACKEND_COMMIT,
  LLVM_BACKEND_RELEASE,
  TRANSCRIBED_FROM,
  type ProofTraceTranscribedSource,
} from "../src/version.ts";
import { caughtAsync } from "./caught.ts";

const encoder = new TextEncoder();

const SHA_ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"; // "abc"
const SHA_EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"; // ""

const RELEASES: ProofTraceReleases = { k: "v9.9.9", llvmBackend: "v0.9.9" };

const LB = "runtimeverification/llvm-backend";
const K = "runtimeverification/k";

const SOURCES: readonly ProofTraceTranscribedSource[] = [
  { repo: LB, path: "docs/proof-trace.md", sha256: SHA_ABC, lines: 1, tier: "format", why: "the grammar" },
  { repo: LB, path: "lib/ast/definition.cpp", sha256: SHA_EMPTY, lines: 1, tier: "ordinal", why: "the numbering" },
  { repo: K, path: "pyk/src/pyk/kllvm/hints/prooftrace.py", sha256: SHA_ABC, lines: 1, tier: "api", why: "the shape" },
];

/** A fetcher serving fixed bodies keyed by `repo:path`, `undefined` otherwise. */
function serving(bodies: Record<string, string>): ProofTraceSourceFetcher {
  return (repo, path) => {
    const body = bodies[`${repo}:${path}`];
    return Promise.resolve(body === undefined ? undefined : encoder.encode(body));
  };
}

const ALL_UNCHANGED = serving({
  [`${LB}:docs/proof-trace.md`]: "abc",
  [`${LB}:lib/ast/definition.cpp`]: "",
  [`${K}:pyk/src/pyk/kllvm/hints/prooftrace.py`]: "abc",
});

describe("sha256Hex", () => {
  test("matches the known digest of the empty input", async () => {
    expect(await sha256Hex(new Uint8Array())).toBe(SHA_EMPTY);
  });

  test("hashes only its own window of a shared buffer", async () => {
    expect(await sha256Hex(encoder.encode("XXXabcXXX").subarray(3, 6))).toBe(SHA_ABC);
  });
});

describe("checkProofTraceSources", () => {
  test("unchanged in all three tiers when every file hashes to what was recorded", async () => {
    const report = await checkProofTraceSources(RELEASES, ALL_UNCHANGED, SOURCES);
    expect(report.verdicts).toEqual({ format: "unchanged", ordinal: "unchanged", api: "unchanged" });
    expect(report.files.every((file) => file.status === "unchanged")).toBe(true);
    expect(report.releases).toEqual(RELEASES);
    expect(report.recordedAt).toEqual({ k: K_RELEASE, llvmBackend: LLVM_BACKEND_RELEASE });
  });

  test("each tier gets its own verdict, and one tier's drift does not move another's", async () => {
    const report = await checkProofTraceSources(
      RELEASES,
      serving({ [`${LB}:docs/proof-trace.md`]: "abc", [`${LB}:lib/ast/definition.cpp`]: "moved" }),
      SOURCES,
    );
    expect(report.verdicts.format).toBe("unchanged");
    // The ordinal file's content changed…
    expect(report.verdicts.ordinal).toBe("changed");
    // …and the api file was not served at all, which is a different answer.
    expect(report.verdicts.api).toBe("could-not-locate");
  });

  test("a demonstrable diff outranks a missing path within a tier", async () => {
    const sources: readonly ProofTraceTranscribedSource[] = [
      { repo: LB, path: "a", sha256: SHA_ABC, lines: 1, tier: "format", why: "" },
      { repo: LB, path: "b", sha256: SHA_ABC, lines: 1, tier: "format", why: "" },
    ];
    const report = await checkProofTraceSources(RELEASES, serving({ [`${LB}:a`]: "different" }), sources);
    expect(report.verdicts.format).toBe("changed");
  });

  test("the release is chosen per repository", async () => {
    const seen: string[] = [];
    await checkProofTraceSources(
      RELEASES,
      (repo, path, release) => {
        seen.push(`${repo}@${release}`);
        return Promise.resolve(encoder.encode(path));
      },
      SOURCES,
    );
    expect(seen).toContain(`${LB}@v0.9.9`);
    expect(seen).toContain(`${K}@v9.9.9`);
  });

  test("a fetcher failure propagates — 'I could not ask' is not 'upstream moved it'", async () => {
    const error = await caughtAsync(
      checkProofTraceSources(RELEASES, () => Promise.reject(new Error("offline")), SOURCES),
      Error,
    );
    expect(error.message).toBe("offline");
  });

  test("the outcome carries the manifest's reason through", async () => {
    const report = await checkProofTraceSources(RELEASES, ALL_UNCHANGED, SOURCES);
    expect(report.files[0]?.why).toBe("the grammar");
  });
});

describe("the manifest", () => {
  test("records both releases and both commits", () => {
    expect(K_RELEASE).toBe("v7.1.337");
    expect(K_COMMIT).toMatch(/^[0-9a-f]{40}$/);
    expect(LLVM_BACKEND_RELEASE).toBe("v0.1.140");
    expect(LLVM_BACKEND_COMMIT).toMatch(/^[0-9a-f]{40}$/);
  });

  test("every entry is well formed and no path is declared twice", () => {
    const keys = TRANSCRIBED_FROM.map((source) => `${source.repo}:${source.path}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const source of TRANSCRIBED_FROM) {
      expect(source.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(source.lines).toBeGreaterThan(0);
      expect(source.why.length).toBeGreaterThan(20);
    }
  });

  test("the format tier is the six files that define the wire", () => {
    // Named individually because the exit code of `prooftrace check-k` depends
    // on exactly this membership: a file quietly demoted out of `format` would
    // turn a breaking change into an advisory one.
    expect(TRANSCRIBED_FROM.filter((source) => source.tier === "format").map((source) => source.path)).toEqual([
      "docs/proof-trace.md",
      "docs/binary-kore-2.md",
      "include/kllvm/binary/ProofTraceParser.h",
      "include/kllvm/binary/deserializer.h",
      "lib/binary/deserializer.cpp",
      "lib/binary/serializer.cpp",
      "include/runtime/proof_trace_writer.h",
    ]);
  });

  test("the ordinal tier is exactly the file that assigns ordinals", () => {
    expect(TRANSCRIBED_FROM.filter((source) => source.tier === "ordinal").map((source) => source.path)).toEqual([
      "lib/ast/definition.cpp",
    ]);
  });

  test("pyk is present, and in the api tier — it is not what this reader was written from", () => {
    const pyk = TRANSCRIBED_FROM.find((source) => source.path.endsWith("kllvm/hints/prooftrace.py"));
    expect(pyk?.tier).toBe("api");
    expect(pyk?.repo).toBe(K);
  });

  test("the format and ordinal tiers are entirely llvm-backend", () => {
    for (const source of TRANSCRIBED_FROM) {
      if (source.tier !== "api") expect(source.repo).toBe(LB);
    }
  });
});
