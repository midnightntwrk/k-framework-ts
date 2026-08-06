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
const goneFetcher: KSourceFetcher = () => Promise.resolve(undefined);

/** Captures both output streams of one `main` invocation. */
function sinks() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, writeOut: (t: string) => void out.push(t), writeErr: (t: string) => void err.push(t) };
}

describe("KAST_SOURCES", () => {
  test("derives one entry per manifest file, in manifest order", () => {
    expect(KAST_SOURCES.map((s) => s.path)).toEqual(TRANSCRIBED_FROM.map((m) => m.path));
    expect(KAST_SOURCES.map((s) => s.sha256)).toEqual(TRANSCRIBED_FROM.map((m) => m.sha256));
  });

  test("hashes are well-formed", () => {
    for (const { sha256 } of KAST_SOURCES) expect(sha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  test("the manifest is the six pyk outer-parser files, each declared once", () => {
    expect(TRANSCRIBED_FROM).toHaveLength(6);
    expect(new Set(TRANSCRIBED_FROM.map((s) => s.path)).size).toBe(6);
    for (const { path, lines } of TRANSCRIBED_FROM) {
      expect(path.startsWith("pyk/src/pyk/kast/")).toBe(true);
      expect(path.endsWith(".py")).toBe(true);
      expect(lines).toBeGreaterThan(0);
    }
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
    expect(s.err.join("")).toContain("k-parser check-k");
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
      files: [
        { path: "a.py", status: "unchanged", expected: "0".repeat(64) },
        { path: "b.py", status: "changed", expected: "0".repeat(64), actual: "f".repeat(64) },
      ],
    });
    expect(text).toContain("ok    a.py");
    expect(text).toContain("DIFF  b.py");
    expect(text).toContain(K_RELEASE);
    expect(text).toContain("v9.9.9");
  });
});
