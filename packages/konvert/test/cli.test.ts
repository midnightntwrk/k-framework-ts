/**
 * The `konvert check-k` command, exercised offline.
 *
 * The fetcher is injected, so none of this touches the network. The
 * unchanged-verdict path is not testable here without serving the real upstream
 * bytes; that logic is covered in `ksources.test.ts` with a synthetic manifest,
 * and `render` is exercised directly below.
 */

import { describe, expect, test } from "bun:test";

import { exitCodeFor, main, render, USAGE } from "../src/cli.ts";
import type { KonvertSourceFetcher, KonvertSourcesReport } from "../src/ksources.ts";
import { TRANSCRIBED_FROM } from "../src/version.ts";

/** Collects a sink's writes. */
function sink(): { text: () => string; write: (t: string) => void } {
  const parts: string[] = [];
  return { text: () => parts.join(""), write: (t) => void parts.push(t) };
}

/** Every declared file exists but hashes differently (bodies are empty). */
const everythingChanged: KonvertSourceFetcher = () => Promise.resolve(new Uint8Array());
/** Every declared file is gone. */
const everythingGone: KonvertSourceFetcher = () => Promise.resolve(undefined);
const offline: KonvertSourceFetcher = () => Promise.reject(new Error("offline"));

describe("main", () => {
  test("no argv prints usage to stderr and exits 2", async () => {
    const out = sink();
    const err = sink();
    expect(await main([], out.write, err.write, everythingChanged)).toBe(2);
    expect(err.text()).toContain(USAGE);
    expect(out.text()).toBe("");
  });

  test("--help prints usage to stdout and exits 0", async () => {
    const out = sink();
    const err = sink();
    expect(await main(["--help"], out.write, err.write, everythingChanged)).toBe(0);
    expect(out.text()).toContain("check-k");
  });

  test("unknown command exits 2", async () => {
    const out = sink();
    const err = sink();
    expect(await main(["frobnicate"], out.write, err.write, everythingChanged)).toBe(2);
    expect(err.text()).toContain("unknown command");
  });

  test("check-k with everything changed exits 1 and reports both tiers", async () => {
    const out = sink();
    const err = sink();
    expect(await main(["check-k", "v9.9.9"], out.write, err.write, everythingChanged)).toBe(1);
    expect(out.text()).toContain("format tier");
    expect(out.text()).toContain("content tier");
    expect(out.text()).toContain("DIFF");
  });

  test("every path gone is could-not-locate: exit 3", async () => {
    const out = sink();
    const err = sink();
    expect(await main(["check-k", "v9.9.9"], out.write, err.write, everythingGone)).toBe(3);
    expect(out.text()).toContain("GONE");
  });

  test("a network failure is could-not-run: exit 2, no verdict", async () => {
    const out = sink();
    const err = sink();
    expect(await main(["check-k", "v9.9.9"], out.write, err.write, offline)).toBe(2);
    expect(err.text()).toContain("could not check");
    expect(out.text()).not.toContain("DIFF");
  });

  test("extra positional arguments exit 2", async () => {
    const out = sink();
    const err = sink();
    expect(await main(["check-k", "a", "b"], out.write, err.write, everythingChanged)).toBe(2);
  });
});

describe("render and exit codes", () => {
  test("content-only drift renders advisory and exits 0", () => {
    const report: KonvertSourcesReport = {
      release: "v9.9.9",
      recordedAt: "v7.1.337",
      verdicts: { format: "unchanged", content: "changed" },
      files: TRANSCRIBED_FROM.map((s) => ({
        path: s.path,
        tier: s.tier,
        status: s.tier === "content" ? ("changed" as const) : ("unchanged" as const),
        expected: s.sha256,
        ...(s.tier === "content" ? { actual: "0".repeat(64) } : {}),
      })),
    };
    const text = render(report);
    expect(text).toContain("format: unchanged");
    expect(text).toContain("content (advisory): CHANGED");
    expect(exitCodeFor(report.verdicts.format)).toBe(0);
  });

  test("exit codes map 0/1/3", () => {
    expect(exitCodeFor("unchanged")).toBe(0);
    expect(exitCodeFor("changed")).toBe(1);
    expect(exitCodeFor("could-not-locate")).toBe(3);
  });
});
