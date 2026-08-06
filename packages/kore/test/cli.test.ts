/**
 * The `kore check-k` command, exercised offline.
 *
 * Fetcher and submodule resolver are injected, so none of this touches the
 * network. The unchanged-verdict path is not testable here without serving
 * the real upstream bytes; that logic is covered in `ksources.test.ts` with
 * a synthetic manifest, and `render` is exercised directly below.
 */

import { describe, expect, test } from "bun:test";
import { exitCodeFor, main, render, USAGE } from "../src/cli.ts";
import type { KoreSourceFetcher, KoreSourcesReport } from "../src/ksources.ts";
import type { SubmoduleResolver } from "../src/cli.ts";
import { TRANSCRIBED_FROM } from "../src/version.ts";

/** Collects a sink's writes. */
function sink(): { text: () => string; write: (t: string) => void } {
  const parts: string[] = [];
  return { text: () => parts.join(""), write: (t) => void parts.push(t) };
}

/** Every declared file exists but hashes differently (bodies are empty). */
const everythingChanged: KoreSourceFetcher = () => Promise.resolve(new Uint8Array());
/** Every declared file is gone. */
const everythingGone: KoreSourceFetcher = () => Promise.resolve(undefined);
const offline: KoreSourceFetcher = () => Promise.reject(new Error("offline"));

const pinned: SubmoduleResolver = () => Promise.resolve("38afc81fc9414f1e11e609b01a43a436b613bd2d");
const neverCalled: SubmoduleResolver = () => Promise.reject(new Error("resolver must not run"));
const gone: SubmoduleResolver = () => Promise.resolve(undefined);
const mustNotFetch: KoreSourceFetcher = () => Promise.reject(new Error("fetch must not run"));

describe("main", () => {
  test("no argv prints usage to stderr and exits 2", async () => {
    const out = sink();
    const err = sink();
    expect(await main([], out.write, err.write, everythingChanged, pinned)).toBe(2);
    expect(err.text()).toContain(USAGE);
    expect(out.text()).toBe("");
  });

  test("--help prints usage to stdout and exits 0", async () => {
    const out = sink();
    const err = sink();
    expect(await main(["--help"], out.write, err.write, everythingChanged, pinned)).toBe(0);
    expect(out.text()).toContain("check-k");
  });

  test("unknown command exits 2", async () => {
    const out = sink();
    const err = sink();
    expect(await main(["frobnicate"], out.write, err.write, everythingChanged, pinned)).toBe(2);
    expect(err.text()).toContain("unknown command");
  });

  test("check-k with everything changed exits 1 and reports both tiers", async () => {
    const out = sink();
    const err = sink();
    const code = await main(["check-k", "v9.9.9"], out.write, err.write, everythingChanged, pinned);
    expect(code).toBe(1);
    expect(out.text()).toContain("format tier");
    expect(out.text()).toContain("content tier");
    expect(out.text()).toContain("DIFF");
    // The resolved submodule pin is surfaced so the user can pin it themselves.
    expect(out.text()).toContain("38afc81fc9414f1e11e609b01a43a436b613bd2d");
  });

  test("an explicit haskell-backend release skips the resolver", async () => {
    const out = sink();
    const err = sink();
    const seen: string[] = [];
    const spy: KoreSourceFetcher = (repo, _path, release) => {
      seen.push(`${repo}@${release}`);
      return Promise.resolve(new Uint8Array());
    };
    const code = await main(["check-k", "v9.9.9", "v0.1.200"], out.write, err.write, spy, neverCalled);
    expect(code).toBe(1);
    expect(seen).toContain("runtimeverification/haskell-backend@v0.1.200");
    expect(seen).toContain("runtimeverification/k@v9.9.9");
  });

  test("a missing submodule pin exits 3 without fetching anything", async () => {
    const out = sink();
    const err = sink();
    expect(await main(["check-k", "v0.0.1"], out.write, err.write, mustNotFetch, gone)).toBe(3);
    expect(err.text()).toContain("cannot be resolved");
  });

  test("every path gone is could-not-locate: exit 3", async () => {
    const out = sink();
    const err = sink();
    expect(await main(["check-k", "v9.9.9"], out.write, err.write, everythingGone, pinned)).toBe(3);
    expect(out.text()).toContain("GONE");
  });

  test("a network failure is could-not-run: exit 2, no verdict", async () => {
    const out = sink();
    const err = sink();
    expect(await main(["check-k", "v9.9.9"], out.write, err.write, offline, pinned)).toBe(2);
    expect(err.text()).toContain("could not check");
    expect(out.text()).not.toContain("DIFF");
  });

  test("extra positional arguments exit 2", async () => {
    const out = sink();
    const err = sink();
    expect(await main(["check-k", "a", "b", "c"], out.write, err.write, everythingChanged, pinned)).toBe(2);
  });
});

describe("render and exit codes", () => {
  const releases = { k: "v9.9.9", haskellBackend: "v0.1.200" };

  test("content-only drift renders advisory and exits 0", () => {
    const report: KoreSourcesReport = {
      releases,
      recordedAt: { k: "v7.1.337", haskellBackend: "v0.1.155" },
      verdicts: { format: "unchanged", content: "changed" },
      files: TRANSCRIBED_FROM.map((s) => ({
        repo: s.repo,
        path: s.path,
        tier: s.tier,
        status: s.tier === "content" ? "changed" : "unchanged",
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
