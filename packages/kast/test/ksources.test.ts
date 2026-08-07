// Offline tests for `check-k`: the fetcher is stubbed, so nothing here touches
// the network. The live behaviour against GitHub is exercised manually and by
// the weekly `k-drift.yml` workflow.
import { describe, expect, test } from "bun:test";
import { exitCodeFor, main, render } from "../src/cli.ts";
import { KAST_SOURCES, checkKSources, sha256Hex, type KSourceFetcher } from "../src/ksources.ts";
import { K_RELEASE, TRANSCRIBED_FROM } from "../src/version.ts";

const encoder = new TextEncoder();

/** A fetcher whose one file hashes to exactly what the manifest records. */
function fetcherReturning(bytes: Record<string, Uint8Array | undefined>): KSourceFetcher {
  return (path) => Promise.resolve(bytes[path]);
}

/** A fetcher standing in for a network that is down. */
const failingFetcher: KSourceFetcher = () => Promise.reject(new Error("network down"));

/** A fetcher for a release where every declared path is gone. */
// oxlint-disable-next-line unicorn/no-useless-undefined -- a clean 404 is the fetcher's declared `undefined` result.
const goneFetcher: KSourceFetcher = () => Promise.resolve(undefined);

/** Captures both output streams of one `main` invocation. */
function sinks() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, writeOut: (t: string) => void out.push(t), writeErr: (t: string) => void err.push(t) };
}

describe("KAST_SOURCES", () => {
  test("derives one entry per manifest file, in manifest order", () => {
    const manifest = Object.values(TRANSCRIBED_FROM);
    expect(KAST_SOURCES.map((s) => s.path)).toEqual(manifest.map((m) => m.path));
    expect(KAST_SOURCES.map((s) => s.sha256)).toEqual(manifest.map((m) => m.sha256));
    expect(KAST_SOURCES.map((s) => s.tier)).toEqual(manifest.map((m) => m.tier));
  });

  test("distinguishes copied behaviour from K-produced content authorities", () => {
    expect(TRANSCRIBED_FROM.userList.tier).toBe("transcription");
    expect(TRANSCRIBED_FROM.toJson.tier).toBe("content");
    expect(TRANSCRIBED_FROM.removeBracketVisitor.tier).toBe("content");
    for (const source of Object.values(TRANSCRIBED_FROM)) {
      if (source.path.startsWith("pyk/")) expect(source.tier).toBe("transcription");
    }
  });

  test("hashes are well-formed", () => {
    for (const { sha256 } of KAST_SOURCES) expect(sha256).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe("checkKSources", () => {
  const content = encoder.encode("some file content\n");

  test("unchanged when every hash matches", async () => {
    const sha256 = await sha256Hex(content);
    const sources = [
      { path: "a.py", sha256 },
      { path: "b.py", sha256 },
    ];
    const report = await checkKSources("v9.9.9", fetcherReturning({ "a.py": content, "b.py": content }), sources);
    expect(report.verdict).toBe("unchanged");
    expect(report.verdicts).toEqual({ transcription: "unchanged", content: "unchanged" });
    expect(report.recordedAt).toBe(K_RELEASE);
    expect(report.files.map((f) => f.status)).toEqual(["unchanged", "unchanged"]);
  });

  test("changed outranks could-not-locate", async () => {
    const sources = [
      { path: "gone.py", sha256: "0".repeat(64) },
      { path: "edited.py", sha256: "0".repeat(64) },
    ];
    const report = await checkKSources("v9.9.9", fetcherReturning({ "edited.py": content }), sources);
    expect(report.verdict).toBe("changed");
    expect(report.files[0]?.status).toBe("missing");
    expect(report.files[1]?.status).toBe("changed");
    expect(report.files[1]?.actual).toBe(await sha256Hex(content));
  });

  test("all-present-but-one-missing is could-not-locate", async () => {
    const sha256 = await sha256Hex(content);
    const sources = [
      { path: "ok.py", sha256 },
      { path: "gone.py", sha256 },
    ];
    const report = await checkKSources("v9.9.9", fetcherReturning({ "ok.py": content }), sources);
    expect(report.verdict).toBe("could-not-locate");
  });

  test("content drift is retained in its tier but remains advisory to the legacy verdict", async () => {
    const sha256 = await sha256Hex(content);
    const sources = [
      { path: "copied.py", sha256, tier: "transcription" as const },
      { path: "authority.java", sha256: "0".repeat(64), tier: "content" as const },
    ];
    const report = await checkKSources(
      "v9.9.9",
      fetcherReturning({ "copied.py": content, "authority.java": content }),
      sources,
    );
    expect(report.verdict).toBe("unchanged");
    expect(report.verdicts).toEqual({ transcription: "unchanged", content: "changed" });
    expect(exitCodeFor(report.verdict)).toBe(0);
    expect(report.files.map((file) => [file.path, file.tier, file.status])).toEqual([
      ["copied.py", "transcription", "unchanged"],
      ["authority.java", "content", "changed"],
    ]);
  });

  test("a missing content authority is advisory too", async () => {
    const sha256 = await sha256Hex(content);
    const report = await checkKSources("v9.9.9", fetcherReturning({ "copied.py": content }), [
      { path: "copied.py", sha256, tier: "transcription" },
      { path: "gone.java", sha256, tier: "content" },
    ]);
    expect(report.verdict).toBe("unchanged");
    expect(report.verdicts).toEqual({ transcription: "unchanged", content: "could-not-locate" });
  });

  test("a fetcher failure propagates instead of becoming a verdict", () => {
    expect(checkKSources("v9.9.9", failingFetcher, [{ path: "a.py", sha256: "0".repeat(64) }])).rejects.toThrow(
      "network down",
    );
  });
});

describe("exit codes are contractual", () => {
  test("0 unchanged, 1 changed, 3 could-not-locate", () => {
    expect(exitCodeFor("unchanged")).toBe(0);
    expect(exitCodeFor("changed")).toBe(1);
    expect(exitCodeFor("could-not-locate")).toBe(3);
  });
});

describe("main", () => {
  test("no arguments is usage on stderr, exit 2", async () => {
    const s = sinks();
    expect(await main([], s.writeOut, s.writeErr)).toBe(2);
    expect(s.err.join("")).toContain("kast-ts check-k");
    expect(s.out).toEqual([]);
  });

  test("--help is usage on stdout, exit 0", async () => {
    const s = sinks();
    expect(await main(["--help"], s.writeOut, s.writeErr)).toBe(0);
    expect(s.out.join("")).toContain("Exit codes");
  });

  test("unknown command exits 2", async () => {
    const s = sinks();
    expect(await main(["frobnicate"], s.writeOut, s.writeErr)).toBe(2);
  });

  test("check-k with no tag exits 2", async () => {
    const s = sinks();
    expect(await main(["check-k"], s.writeOut, s.writeErr)).toBe(2);
    expect(s.err.join("")).toContain(K_RELEASE);
  });

  test("a failing fetch is exit 2, not a verdict", async () => {
    const s = sinks();
    expect(await main(["check-k", "v9.9.9"], s.writeOut, s.writeErr, failingFetcher)).toBe(2);
    expect(s.err.join("")).toContain("could not check v9.9.9");
  });

  test("a clean run renders the report and exits by verdict", async () => {
    const s = sinks();
    // Everything missing → could-not-locate → 3.
    expect(await main(["check-k", "v9.9.9"], s.writeOut, s.writeErr, goneFetcher)).toBe(3);
    const text = s.out.join("");
    expect(text).toContain("GONE");
    expect(text).toContain("the manifest needs re-establishing");
  });
});

describe("render", () => {
  test("one line pair per file, summary names both releases", () => {
    const text = render({
      release: "v9.9.9",
      recordedAt: K_RELEASE,
      verdict: "changed",
      verdicts: { transcription: "changed", content: "changed" },
      files: [
        { path: "a.py", tier: "transcription", status: "unchanged", expected: "0".repeat(64) },
        { path: "b.java", tier: "content", status: "changed", expected: "0".repeat(64), actual: "f".repeat(64) },
      ],
    });
    expect(text).toContain("ok    a.py");
    expect(text).toContain("DIFF  b.java");
    expect(text).toContain("transcription tier");
    expect(text).toContain("content tier");
    expect(text).toContain("advisory");
    expect(text).toContain(K_RELEASE);
    expect(text).toContain("v9.9.9");
  });
});
