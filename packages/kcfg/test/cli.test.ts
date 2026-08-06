import { describe, expect, test } from "bun:test";
import { exitCodeFor, main, render } from "../src/cli.ts";
import type { KcfgSourceFetcher } from "../src/ksources.ts";

const encoder = new TextEncoder();

function serving(bodies: Record<string, string>): KcfgSourceFetcher {
  return (path) => Promise.resolve(bodies[path] === undefined ? undefined : encoder.encode(bodies[path]));
}

async function run(argv: readonly string[], fetcher: KcfgSourceFetcher = serving({})) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(
    argv,
    (text) => {
      out.push(text);
    },
    (text) => {
      err.push(text);
    },
    fetcher,
  );
  return { code, out: out.join(""), err: err.join("") };
}

describe("kcfg check-k CLI", () => {
  test("has distinct contractual exit codes", () => {
    expect(exitCodeFor("unchanged")).toBe(0);
    expect(exitCodeFor("changed")).toBe(1);
    expect(exitCodeFor("could-not-locate")).toBe(3);
  });

  test("reports usage failures with exit code 2", async () => {
    expect((await run([])).code).toBe(2);
    expect((await run(["check-k"])).code).toBe(2);
    expect((await run(["nope"])).code).toBe(2);
  });

  test("renders help on stdout", async () => {
    const result = await run(["--help"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("check-k <k-release>");
    expect(result.err).toBe("");
  });

  test("does not report a fetch failure as source drift", async () => {
    const result = await run(["check-k", "v9.9.9"], () => Promise.reject(new Error("offline")));
    expect(result.code).toBe(2);
    expect(result.err).toContain("could not check v9.9.9: offline");
  });

  test("explains that a missing path is not a compatibility verdict", () => {
    const text = render({
      release: "v9.9.9",
      recordedAt: "v7.1.337",
      verdict: "could-not-locate",
      files: [],
    });
    expect(text).toContain("not a verdict about compatibility");
  });
});
