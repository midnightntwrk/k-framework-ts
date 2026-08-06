/**
 * The `kfuzz` command — one subcommand, `check-k`, and the exit-code contract
 * `docs/versioning.md` fixes for the whole repository.
 *
 * `main` is a pure function of `(argv, out, err, fetcher)`, so every case runs
 * in-process with no network and no spawn.
 */

import { describe, expect, test } from "bun:test";

import { exitCodeFor, main, render, USAGE } from "../src/cli.ts";
import type { KfuzzSourceFetcher } from "../src/ksources.ts";
import { K_RELEASE, TRANSCRIBED_FROM } from "../src/version.ts";

const encoder = new TextEncoder();

/** The fetcher every non-`check-k` case gets: reaching GitHub here is a bug. */
const OFFLINE: KfuzzSourceFetcher = () => {
  throw new Error("no test may reach the network");
};

/**
 * A fetcher that serves the wrong bytes for every declared path.
 *
 * There is no offline way to serve bytes whose sha256 *matches* the manifest —
 * that would need a preimage — so the `unchanged` rendering is exercised
 * through `render` directly, at the bottom of this file, and `main` is driven
 * over the two outcomes a fetcher can actually produce.
 */
const SERVING_WRONG_BYTES: KfuzzSourceFetcher = () => Promise.resolve(encoder.encode("something else entirely"));

/** A fetcher for which every declared path 404s: K moved everything. */
const SERVING_NOTHING: KfuzzSourceFetcher = () => Promise.resolve(undefined);

async function run(argv: readonly string[], fetcher: KfuzzSourceFetcher = OFFLINE) {
  let out = "";
  let err = "";
  const code = await main(
    argv,
    (text) => {
      out += text;
    },
    (text) => {
      err += text;
    },
    fetcher,
  );
  return { code, out, err };
}

describe("usage", () => {
  test("no command prints usage to stderr and exits 2", async () => {
    const { code, out, err } = await run([]);
    expect(code).toBe(2);
    expect(out).toBe("");
    expect(err).toContain(USAGE);
  });

  test("--help prints usage to stdout and exits 0", async () => {
    for (const flag of ["--help", "-h", "help"]) {
      const { code, out } = await run([flag]);
      expect(code).toBe(0);
      expect(out).toContain(USAGE);
    }
  });

  test("an unknown command exits 2 and names it", async () => {
    const { code, err } = await run(["fuzz"]);
    expect(code).toBe(2);
    expect(err).toContain("unknown command: fuzz");
  });

  test("usage says there is no run subcommand, and why", () => {
    expect(USAGE).toContain("no subcommand that runs a fuzzer");
    expect(USAGE).toContain(K_RELEASE);
  });
});

describe("check-k", () => {
  test("a changed source exits 1 and names the diff", async () => {
    const { code, out } = await run(["check-k", "v9.9.9"], SERVING_WRONG_BYTES);
    expect(code).toBe(1);
    for (const source of TRANSCRIBED_FROM) expect(out).toContain(`DIFF  ${source.path}`);
    expect(out).toContain("Diff it before trusting this package at that release.");
  });

  test("paths K has moved exit 3, and are not reported as a compatibility verdict", async () => {
    const { code, out } = await run(["check-k", "v9.9.9"], SERVING_NOTHING);
    expect(code).toBe(3);
    for (const source of TRANSCRIBED_FROM) expect(out).toContain(`GONE  ${source.path}`);
    expect(out).toContain("not a verdict about compatibility");
  });

  test("a fetch failure exits 2 — 'could not ask' is not a verdict", async () => {
    const { code, err } = await run(["check-k", "v9.9.9"], () => Promise.reject(new Error("network down")));
    expect(code).toBe(2);
    expect(err).toContain("could not check v9.9.9: network down");
  });

  test("wrong arity is a usage error", async () => {
    expect((await run(["check-k"])).code).toBe(2);
    expect((await run(["check-k", "v1", "v2"])).code).toBe(2);
  });
});

describe("render and exitCodeFor", () => {
  test("the exit-code contract: 0 unchanged, 1 changed, 3 could not locate", () => {
    expect(exitCodeFor("unchanged")).toBe(0);
    expect(exitCodeFor("changed")).toBe(1);
    expect(exitCodeFor("could-not-locate")).toBe(3);
  });

  test("an all-unchanged report reads as current for the release", () => {
    const text = render({
      release: "v9.9.9",
      recordedAt: K_RELEASE,
      verdict: "unchanged",
      files: [
        { path: "pyk/a.py", status: "unchanged", expected: "a".repeat(64), tier: "transcription", why: "because" },
      ],
    });
    expect(text).toContain("ok    pyk/a.py");
    expect(text).toContain(`unchanged since ${K_RELEASE}`);
    expect(text).toContain("current for K v9.9.9");
  });

  test("a could-not-locate report refuses to be read as a verdict", () => {
    const text = render({
      release: "v9.9.9",
      recordedAt: K_RELEASE,
      verdict: "could-not-locate",
      files: [{ path: "pyk/a.py", status: "missing", expected: "a".repeat(64), tier: "transcription", why: "because" }],
    });
    expect(text).toContain("GONE  pyk/a.py");
    expect(text).toContain("not a verdict about compatibility");
  });
});
