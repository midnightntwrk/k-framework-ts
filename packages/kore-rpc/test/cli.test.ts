/**
 * The three `kore-rpc-ts` subcommands, exercised offline and off-disk.
 *
 * Every effect is injected: the fetcher and the submodule resolver, so nothing
 * touches the network, and a {@link FileSystem} over a plain map, so
 * `rpc-print` and `rpc-kast` never see a real file. What each of those two
 * *produces* is `inspect.test.ts`'s subject; what is checked here is the shell
 * around them — argument parsing, `--output-file`, and the exit codes.
 *
 * `check-k`'s unchanged-verdict path is not testable here without serving the
 * real upstream bytes; that logic is covered in `ksources.test.ts` with a
 * synthetic manifest, and `render` is exercised directly below.
 */

import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { type FileSystem, type SubmoduleResolver, exitCodeFor, main, render, USAGE } from "../src/cli.ts";
import type { KoreRpcSourceFetcher, KoreRpcSourcesReport } from "../src/ksources.ts";
import { TRANSCRIBED_FROM } from "../src/version.ts";
import { fixturePath } from "./fixtures.ts";

/** Collects a sink's writes. */
function sink(): { text: () => string; write: (t: string) => void } {
  const parts: string[] = [];
  return { text: () => parts.join(""), write: (t) => void parts.push(t) };
}

/** A {@link FileSystem} over a map, recording what was written. */
function memoryFs(
  files: Readonly<Record<string, string>> = {},
): FileSystem & { readonly written: Map<string, string> } {
  const written = new Map<string, string>();
  return {
    written,
    readFile(path: string): string {
      const contents = files[path];
      if (contents === undefined) throw new Error(`ENOENT: no such file or directory, open '${path}'`);
      return contents;
    },
    writeFile(path: string, text: string): void {
      written.set(path, text);
    },
  };
}

/** One of pyk's vendored `rpc-print`/`rpc-kast` corpus files, as text. */
function pykRpcText(...segments: readonly string[]): string {
  return readFileSync(fixturePath("pyk-rpc", ...segments), "utf8");
}

/** Every declared file exists but hashes differently (bodies are empty). */
const everythingChanged: KoreRpcSourceFetcher = () => Promise.resolve(new Uint8Array());
/** Every declared file is gone. */
const everythingGone: KoreRpcSourceFetcher = () => Promise.resolve(undefined);
const offline: KoreRpcSourceFetcher = () => Promise.reject(new Error("offline"));

const pinned: SubmoduleResolver = () => Promise.resolve("38afc81fc9414f1e11e609b01a43a436b613bd2d");
const neverCalled: SubmoduleResolver = () => Promise.reject(new Error("resolver must not run"));
const gone: SubmoduleResolver = () => Promise.resolve(undefined);
const mustNotFetch: KoreRpcSourceFetcher = () => Promise.reject(new Error("fetch must not run"));

describe("main", () => {
  test("no argv prints usage to stderr and exits 2", async () => {
    const out = sink();
    const err = sink();
    expect(await main([], out.write, err.write, everythingChanged, pinned)).toBe(2);
    expect(err.text()).toContain(USAGE);
    expect(out.text()).toBe("");
  });

  test("--help prints usage to stdout and exits 0, listing all three commands", async () => {
    const out = sink();
    const err = sink();
    expect(await main(["--help"], out.write, err.write, everythingChanged, pinned)).toBe(0);
    expect(out.text()).toContain("check-k");
    expect(out.text()).toContain("rpc-print");
    expect(out.text()).toContain("rpc-kast");
    expect(out.text()).toContain("kore-rpc-ts check-k");
    expect(out.text()).not.toContain("kore-rpc check-k");
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
    const spy: KoreRpcSourceFetcher = (repo, _path, release) => {
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

describe("rpc-print", () => {
  const fs = memoryFs({
    "req.json": pykRpcText("print", "imp-execute-request.json"),
    "resp.json": pykRpcText("print", "imp-execute-stuck-response.json"),
    "not-json.txt": "{",
    "neither.json": '{"jsonrpc":"2.0","id":1}',
  });

  test("prints a request to stdout, newline-terminated", async () => {
    const out = sink();
    const err = sink();
    expect(await main(["rpc-print", "req.json"], out.write, err.write, mustNotFetch, neverCalled, fs)).toBe(0);
    expect(out.text().startsWith("JSON RPC request\nid: 1\nMethod: execute\n")).toBe(true);
    expect(out.text().endsWith("\n")).toBe(true);
    expect(err.text()).toBe("");
  });

  test("--output-file writes there instead, and stdout stays empty", async () => {
    const out = sink();
    const err = sink();
    const target = memoryFs({ "resp.json": pykRpcText("print", "imp-execute-stuck-response.json") });
    const code = await main(
      ["rpc-print", "resp.json", "--output-file", "out.txt"],
      out.write,
      err.write,
      mustNotFetch,
      neverCalled,
      target,
    );
    expect(code).toBe(0);
    expect(out.text()).toBe("");
    expect(target.written.get("out.txt")).toContain("Stop reason: stuck");
  });

  test("a missing file is exit 1 with the platform's message", async () => {
    const out = sink();
    const err = sink();
    expect(await main(["rpc-print", "nope.json"], out.write, err.write, mustNotFetch, neverCalled, fs)).toBe(1);
    expect(err.text()).toContain("nope.json");
  });

  test("a file that is not JSON is exit 1 and names the file", async () => {
    const out = sink();
    const err = sink();
    expect(await main(["rpc-print", "not-json.txt"], out.write, err.write, mustNotFetch, neverCalled, fs)).toBe(1);
    expect(err.text()).toContain("not-json.txt is not JSON");
  });

  test("a document that is neither a request nor a response is exit 1", async () => {
    const out = sink();
    const err = sink();
    expect(await main(["rpc-print", "neither.json"], out.write, err.write, mustNotFetch, neverCalled, fs)).toBe(1);
    expect(err.text()).toContain("neither a request nor a response");
  });

  test("the wrong number of files, and an unknown option, are usage errors", async () => {
    const out = sink();
    const err = sink();
    expect(await main(["rpc-print"], out.write, err.write, mustNotFetch, neverCalled, fs)).toBe(2);
    expect(err.text()).toContain("rpc-print takes exactly one file");
    const err2 = sink();
    expect(await main(["rpc-print", "a.json", "b.json"], out.write, err2.write, mustNotFetch, neverCalled, fs)).toBe(2);
    const err3 = sink();
    expect(await main(["rpc-print", "--wat", "a.json"], out.write, err3.write, mustNotFetch, neverCalled, fs)).toBe(2);
    expect(err3.text()).toContain("unknown option: --wat");
    const err4 = sink();
    expect(await main(["rpc-print", "a.json", "-o"], out.write, err4.write, mustNotFetch, neverCalled, fs)).toBe(2);
    expect(err4.text()).toContain("-o takes a value");
  });
});

describe("rpc-kast", () => {
  const fs = memoryFs({
    "ref.json": pykRpcText("kast", "imp-execute-request.json"),
    "resp.json": pykRpcText("kast", "imp-execute-depth-bound-response.json"),
  });

  test("prints one line of JSON matching pyk's golden", async () => {
    const out = sink();
    const err = sink();
    const code = await main(["rpc-kast", "ref.json", "resp.json"], out.write, err.write, mustNotFetch, neverCalled, fs);
    expect(code).toBe(0);
    // One line: the trailing newline is the only one.
    expect(out.text().trimEnd().includes("\n")).toBe(false);
    expect(JSON.parse(out.text())).toEqual(
      JSON.parse(pykRpcText("kast", "imp-execute-request-from-execute-response.json.golden")),
    );
  });

  test("takes exactly two files", async () => {
    const out = sink();
    const err = sink();
    expect(await main(["rpc-kast", "ref.json"], out.write, err.write, mustNotFetch, neverCalled, fs)).toBe(2);
    expect(err.text()).toContain("a reference request and a response");
  });

  test("a response that is not an execute response is exit 1", async () => {
    const out = sink();
    const err = sink();
    const bad = memoryFs({ "ref.json": pykRpcText("kast", "imp-execute-request.json"), "r.json": '{"result":{}}' });
    expect(await main(["rpc-kast", "ref.json", "r.json"], out.write, err.write, mustNotFetch, neverCalled, bad)).toBe(
      1,
    );
    expect(err.text().length).toBeGreaterThan(0);
  });
});

describe("render and exit codes", () => {
  const releases = { k: "v9.9.9", haskellBackend: "v0.1.200" };

  test("content-only drift renders advisory and exits 0", () => {
    const report: KoreRpcSourcesReport = {
      releases,
      recordedAt: { k: "v7.1.337", haskellBackend: "v0.1.155" },
      verdicts: { format: "unchanged", content: "changed" },
      files: TRANSCRIBED_FROM.map((s) => ({
        repo: s.repo,
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
    // Both repositories are named in the listing, so a reader can tell which
    // tree a path lives in without knowing the layout.
    expect(text).toContain("runtimeverification/haskell-backend:");
    expect(text).toContain("runtimeverification/k:");
    expect(exitCodeFor(report.verdicts.format)).toBe(0);
  });

  test("exit codes map 0/1/3", () => {
    expect(exitCodeFor("unchanged")).toBe(0);
    expect(exitCodeFor("changed")).toBe(1);
    expect(exitCodeFor("could-not-locate")).toBe(3);
  });
});
